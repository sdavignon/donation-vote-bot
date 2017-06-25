'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for');

const
  DB_RECORDS = "records";

const
  RECORDS_FETCH_LIMIT = 100;

var ObjectID = mongodb.ObjectID;
var db;


// Connect to the database first
mongodb.MongoClient.connect(process.env.MONGODB_URI, function (err, database) {
  if (err) {
    console.log(err);
    process.exit(1);
  }

  db = database;
  console.log("Database connection ready");

  main();
});

function main() {
  console.log("donation-vote-bot waking up");
  steem.config.set('websocket','wss://steemd.steemit.com');
  getLastInfos(function (lastTransactionTimeAsEpoch, lastTransactionNumber) {
    readTransfers(lastTransactionTimeAsEpoch, lastTransactionTimeAsEpoch,
        function (transactions) {
          console.log("***FINISHED***");
          if (transactions === undefined
             || transactions === null) {
            console.log("Error getting transactions");
            console.log(err, transactions);
          } else {
            console.log("Got "+transactions.length+" transactions");
            console.log(JSON.stringify(transactions));
          }
        });
  });
}

function steem_getAccountHistory_wrapper(start, limit, callback) {
  steem.api.getAccountHistory(process.env.STEEM_USER, start, limit, function (err, result) {
    callback(err, result);
  });
}

function steem_getContent_wrapper(author, permlink, callback) {
  steem.api.getContent(author, permlink, function (err, result) {
    callback(err, result);
  });
}

function readTransfers(lastTransactionTimeAsEpoch,
                          lastTransactionNumber,
                          callback) {
  wait.launchFiber(function() {
    var transfers = [];
    var keepProcessing = true;
    var idx = 0;
    var transactionCounter = 0;
    while(keepProcessing) {
      var result = wait.for(steem_getAccountHistory_wrapper,
        idx + RECORDS_FETCH_LIMIT, RECORDS_FETCH_LIMIT);
      if (result === undefined || result === null
          || result.length < 1) {
        console.log("fatal error, cannot get account history" +
          " (transfers), may be finished normally, run out of data");
        callback(transfers);
        keepProcessing = false;
        break;
      } else {
        //console.log(JSON.stringify(result));
        for (var j = 0 ; j < result.length ; j++) {
          var r = result[j];
          if (r[0] < transactionCounter) {
            // this means the API returned older results than we asked
            // for, meaning there are no more recent transactions to get
            console.log("API has no more results, ending fetch");
            callback(transfers);
            keepProcessing = false;
            break;
          }
          transactionCounter = r[0];
          if (r !== undefined && r !== null && r.length > 1) {
            var transaction = r[1];
            var ops = transaction.op;
            if (ops === undefined || ops === null || ops.length < 2) {
              console.log("processTransactionOp_recursive failed, back ops: "+JSON.stringify(ops));
            } else {
              for (var i = 0 ; i < ops.length ; i += 2) {
                var opName = ops[i];
                //console.log(" - op: "+opName);
                if (opName.localeCompare("transfer") == 0) {
                  var opDetail = ops[i+1];
                  // verifyTransferIsValid
                  console.log(" - - - - detail: "+JSON.stringify(opDetail));
                  var amountParts = opDetail.amount.split(" ");
                  if (amountParts.length === 2) {
                    var amount = Number(amountParts[0]);
                    var asset = amountParts[1];
                    if (asset.localeCompare("STEEM") == 0) {
                      console.log(" - - - - MATCH, is for STEEM");
                      if (amount >= 1.0) {
                        console.log(" - - - - MATCH, amount >= 1.0");
                        var parts = opDetail.memo.split("/");
                        if (parts.length > 0) {
                          var permlink = parts[parts.length - 1];
                          var author = null;
                          for (var i = 0; i < parts.length; i++) {
                            if (S(parts[i]).startsWith("@")) {
                              author = parts[i].substr(1, parts[i].length);
                            }
                          }
                          if (author !== null) {
                            // check exists by fetching from Steem API
                            var content = wait.for(steem_getContent_wrapper, author, permlink);
                            if (content == undefined || content === null) {
                              console.log("Transfer memo does not" +
                                " contain valid post URL" +
                                " (failed at fetch author/permlink content from API): "
                                + opDetail.memo);
                            } else {
                              //console.log("DEBUG get post content: " +
                              // JSON.stringify(content));
                              var match = false;
                              try {
                                for (var k = 0 ; k < content.active_votes.length ; k++) {
                                  if (content.active_votes[k].voter.localeCompare(process.env.STEEM_USER) == 0) {
                                    match = true;
                                    break;
                                  }
                                }
                              } catch(err) {
                                console.log("Error analysing memo linked" +
                                  " post for votes");
                              }
                              if (match) {
                                console.log("Already voted on this post," +
                                  " skipping");
                              } else {
                                // check time since posted is < (7 days
                                // - 12 hrs)
                                var cashoutTime = moment(content.cashout_time);
                                cashoutTime.subtract(7, 'hours');
                                var nowTime = moment(new Date());
                                if (nowTime.isBefore(cashoutTime)) {
                                  // PASSES ALL TESTS, add to list
                                  transfers.push(opDetail);
                                  console.log("MEMO LINKED POST PASSES" +
                                    " TESTS, will vote on");
                                } else {
                                  console.lgo("Memo linked post is too" +
                                    " old to vote on, skipping");
                                }
                              }
                            }
                          } else {
                            console.log("Transfer memo does not contain valid post URL (failed" +
                              " to find user name at @ symbol): " + opDetail.memo);
                          }
                        } else {
                          console.log("Transfer memo does not contain valid post URL (failed" +
                            " at URL split by /): " + opDetail.memo);
                        }
                      } else {
                        console.log("Transfer amount < 1.0 STEEM");
                      }
                    } else {
                      console.log("Transfer is not for STEEM");
                    }
                  } else {
                    console.log("Transfer amount field is invalid");
                  }
                }
              }
            }
            idx += RECORDS_FETCH_LIMIT;
          } else {
            console.log("fatal error, cannot get account history" +
              " (transfers), may be finished normally, run out of data");
            callback(transfers);
            keepProcessing = false;
            break;
          }
        }
      }
    }
  });
}

function getLastInfos(callback) {
  db.collection(DB_RECORDS).find({}).toArray(function(err, data) {
    if (err) {
      console.log(err);
      console.log("Error, exiting");
      callback(0, 0);
      return;
    }
    var lastTransactionNumber = -1;
    var lastTransactionTimeAsEpoch = 0;
    if (process.env.START_TIME_AS_EPOCH !== undefined
      && process.env.START_TIME_AS_EPOCH !== null) {
      try {
        lastTransactionTimeAsEpoch = Number(process.env.START_TIME_AS_EPOCH);
      } catch(err) {
        console.log("Error converting env var START_TIME_AS_EPOCH to" +
          " number");
        lastTransactionTimeAsEpoch = 0;
      }
    }
    if (data === undefined || data === null) {
      console.log("Db data does not exist, consider this a first time run");
      try {
        if (lastTransactionTimeAsEpoch < data[0].timeAsEpoch) {
          lastTransactionTimeAsEpoch = data[0].timeAsEpoch;
        }
        lastTransactionNumber = data[0].trxNumber;
      } catch(err) {
        console.log(err);
        console.log("not fatal, continuing");
      }
    }
    callback(lastTransactionTimeAsEpoch, lastTransactionNumber);
  });
}