var Promise = require('bluebird');
var AWS = require("aws-sdk"),
    configLoader = require("./lib/dynamodb-config"),
    csv = Promise.promisifyAll(require('csv')),
    mturk = require('mturk'),
    s3 = Promise.promisifyAll(new AWS.S3()),
    sanitizeHtml = require('sanitize-html'),
    sns = Promise.promisifyAll(new AWS.SNS()),
    sqs = Promise.promisifyAll(new AWS.SQS()),
    xml2js = Promise.promisifyAll(require('xml2js').Parser());
var snsArns = {};

exports.ping = function(event, lambdaContext) {
  console.log('Running task-integrator Mechanical Turk ping function');

  var stackName = getStackName(lambdaContext.functionName, '');
  init(stackName)
  .then(function(context) {
    context.mturkClient
    .GetAccountBalanceAsync({})
    .then(function(balance) {
      lambdaContext.succeed(balance + " credits in the account");
    })
    .catch(error);
  });
};

/**
 * Example 'flattening' of promise tree.
 *
 * 1. Break up .then() functions into separate named functions
 * 2. Organize the returned data so the then calls can be chained.
 */
exports.upload = function(event, lambdaContext) {
  console.log('Running task-integrator Mechanical Turk upload function');

  /**
   * Create BaseRequest from config layouts
   */
  function getBaseRequest (context, record) {
    var objectKey = record.s3.object.key;
    var hitLayoutId = objectKey.substr(0, objectKey.indexOf('/'));
    if (hitLayoutId) {
      var baseRequest = context.config.layouts[hitLayoutId];
      if (baseRequest) {
        baseRequest["HITLayoutId"] = hitLayoutId;
        return baseRequest;
      } else {
        throw "HitLayoutId [" + hitLayoutId + "] does not have an entry in configuration.";
      }
    } else {
      throw "Object [" + objectKey + "] does not have a HITLayoutId in its path.";
    }
  }

  /**
   * Fetch the S3 Object for the record
   */
  function createHitsForCsv (context, record) {
    getBaseRequest(context, record).then(function (baseRequest) {
      return s3
        .getObjectAsync({
          Bucket: record.s3.bucket.name,
          Key: record.s3.object.key
        })
        .then(function(s3Object) {
          return createHitsForCsv(s3Object.Body, baseRequest, context.mturkClient);
        });
    });
  }

  /**
   * Set up notifications for the the HITType. Only needs to happen once for
   * the entire batch.              [description]
   */
  function setupNotifications (context, recordsHITIds) {
    var hitIds = flatten(recordsHITIds);
    if (hitIds.length > 0) {
      return setupNotificationsForHit(hitIds[0], context.mturkClient, context.config.turk_notification_queue).then(function() {
        return hitIds;
      });
    } else {
      return hitIds;
    }
  }

  var stackName = getStackName(lambdaContext.functionName, 'MTurkImporterFunction');

  /**
   * Flow of code is much easier to tease out now. Aka:
   *
   * 1. For each Record, setup hits for the csv
   * 2. Make sure notifcations are set up
   * 3. Let the context know all is good
   */
  init(stackName)
  .then(function(context) {
    return Promise
    .map(event.Records, createHitsForCsv.bind(context))
    .then(setupNotifications.bind(context))
    .then(function(hitIds) {
      lambdaContext.succeed("[" + hitIds.length + "] HITs created.");
    });
  })
  .catch(error);
}

exports.export = function(event, lambdaContext) {
  console.log('Running task-integrator Mechanical Turk export function');

  var stackName = getStackName(lambdaContext.functionName, 'MTurkExporterFunction');
  init(stackName)
  .then(function(context) {
    return Promise
    .map(
      "0123456789".split(""), // Iterate 10 times, because SQS does not guarantee delivery or order
      function(n) {
        return sqs
        .receiveMessageAsync({
          QueueUrl: context.config.turk_notification_queue,
          MaxNumberOfMessages: 10
        })
        .then(function(data) {
          if (data.Messages && data.Messages.length > 0) {
            return Promise
            .map(
              data.Messages,
              function(message) {
                console.log("Received Mechanical Turk notification: " + message.Body);
                return moveFromMturkToSns(JSON.parse(message.Body), stackName, context.mturkClient)
                .then(function(messageIds) {
                  return sqs
                  .deleteMessageAsync({
                    QueueUrl: context.config.turk_notification_queue,
                    ReceiptHandle: message.ReceiptHandle
                  })
                  .then(function(data) {
                    return messageIds;
                  });
                });
              }
            );
          } else {
            return [];
          }
        });
      }
    )
    .then(function(results) {
      var flattened = flatten(results);
      console.log('[' + flattened.join(',') + '] messages created');
      lambdaContext.succeed(flattened.length + ' messages pushed to SNS.');
    });
  })
  .catch(error);
}

// --- Private helper functions ---

// Returns a Promise of the array of resultant HITIds.
function createHitsForCsv(csvBody, baseRequest, mturkClient) {
  return csv
  .parseAsync(csvBody)
  .then(function(csvDoc) {
    var header = csvDoc.shift();
    return Promise.map(
      csvDoc,
      function(row) {
        var hitLayoutParameters = {};
        var request = baseRequest;
        for (var i = 0; i < header.length; i++) {
          hitLayoutParameters[header[i]] = sanitizeHtml(row[i]);
        }
        request["HITLayoutParameters"] = hitLayoutParameters;
        console.log("Creating HIT: " + JSON.stringify(request));
        return mturkClient
        .CreateHITAsync(request)
        .then(function(hitId) {
          console.log("Created HIT " + hitId);
          return hitId;
        });
      }
    );
  });
}

// Returns a Promise containing the SNS ARN for the SNS Topic for the HIT's HITLayoutId
function getSnsArn(hitId, stackName, mturkClient) {
  return mturkClient
  .GetHITAsync({ HITId: hitId })
  .then(function(hit) {
    if (snsArns[hit.HITLayoutId] == undefined) {
      return sns
      .createTopicAsync({ Name: stackName + "-" + hit.HITLayoutId })
      .then(function(data) {
        snsArns[hit.HITLayoutId] = data.TopicArn; // Save for later
        return data.TopicArn;
      });
    } else {
      return snsArns[hit.HITLayoutId];
    }
  });
}

// The functionIdentifier must match the section from the CloudFormation template that creates the Lambda function.
function getStackName(functionName, functionIdentifier) {
  var i = functionName.indexOf("-" + functionIdentifier);
  if (functionIdentifier && i >= 0)
    return functionName.substr(0, i);
  else
    return functionName;
}

// Returns a Promise containing an aray of messageIds of the resultant SNS messages.
function moveFromMturkToSns(notificationMsg, stackName, mturkClient) {
  return Promise
  .map(
    notificationMsg.Events,
    function(event) {
      return mturkClient
      .GetAssignmentAsync({ AssignmentId: event.AssignmentId })
      .then(function(assignment) {
        return getSnsArn(assignment.HITId, stackName, mturkClient)
        .then(function(topicArn) {
          return xml2js
          .parseStringAsync(assignment.Answer)
          .then(function(doc) {
            doc = xml2js2JSON(doc);
            message = {};
            doc.QuestionFormAnswers.Answer.forEach(function(answer) {
              // TODO: support an uploaded file here
              message[answer.QuestionIdentifier] = answer.FreeText || answer.SelectionIdentifier || answer.OtherSelectionText;
            });
            return sns
            .publishAsync({
              Message: JSON.stringify(message),
              TopicArn: topicArn
            })
            .then(function(data) {
              console.log("Sending message to SNS: " + JSON.stringify(message));
              return data.MessageId;
            });
          });
        });
      });
    }
  );
}

// Returns a Promise with the given hitId
function setupNotificationsForHit(hitId, mturkClient, destinationQueueUrl) {
  return mturkClient
  .GetHITAsync({ HITId: hitId })
  .then(function(hit) {
    return mturkClient
    .SetHITTypeNotificationAsync({
      HITTypeId: hit.HITTypeId,
      Active: true,
      Notification: {
        Destination: destinationQueueUrl,
        Transport: "SQS",
        Version: "2006-05-05",
        EventType: ["AssignmentSubmitted", ""]
      }
    })
    .then(function(hitId) {
      console.log("Set up notifications for HITTypeId " + hit.HITTypeId);
      return hitId;
    });
  });
}

// Returns a Promise with a populated context object: {mtuckClient, config}
function init(stackName) {
  return configLoader
  .loadConfig(stackName + "-config")
  .then(function(config) {
    return {
      mturkClient: Promise.promisifyAll(mturk({
        creds: {
          accessKey: config.auth.access_key,
          secretKey: config.auth.secret_key
        },
        sandbox: config.sandbox
      })),
      config: config
    };
  });
}

// Converts the xml2js format (each property is an array) to a more typical
// JSON format (each property is the single value, unless the array is larger than 1 member).
function xml2js2JSON(elem) {
  if (typeof elem === 'string' || elem instanceof String) {
    return elem;
  } else if (elem && elem.length && elem.length <= 1) {
    return xml2js2JSON(elem[0]);
  } else if (elem && elem.length) {
    var converted = [];
    for (var i = 0; i < elem.length; i++) {
      converted.push(xml2js2JSON(elem[i]));
    };
    return converted;
  } else {
    var converted = {};
    Object.getOwnPropertyNames(elem).forEach(function(key) {
      converted[key] = xml2js2JSON(elem[key]);
    });
    return converted;
  }
}

function error(err) {
  console.error("Error:", err, err.stack);
  throw err;
}

function flatten(arrayOfArrays) {
  return [].concat.apply([], arrayOfArrays)
}
