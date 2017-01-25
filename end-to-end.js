/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
// This is an end-to-end test that focuses on exercising all parts of the fabric APIs
// in a happy-path scenario
'use strict';

var log4js = require('log4js');
var logger = log4js.getLogger('E2E');
logger.setLevel('DEBUG');

var path = require('path');

var hfc = require('hfc');
hfc.setLogger(logger);

var util = require('util');
var utils = require('hfc/lib/utils.js');
var Peer = require('hfc/lib/Peer.js');
var Orderer = require('hfc/lib/Orderer.js');

var path = require('path');
var fs = require('fs');
var os = require('os');

var jsrsa = require('jsrsasign');
var KEYUTIL = jsrsa.KEYUTIL;

var copService = require('hfc-cop/lib/FabricCOPImpl.js');
var User = require('hfc/lib/User.js');
var CryptoSuite = require('hfc/lib/impl/CryptoSuite_ECDSA_AES.js');
var FileStore = require('hfc/lib/impl/FileKeyValueStore.js');
var ecdsaKey = require('hfc/lib/impl/ecdsa/key.js');

var client = new hfc();
var chain = client.newChain('end-to-end-chain-test');

var webUser = null;
var chaincodeID = 'mycc';
var channelID = 'myc1';
var tx_id = null;
var nonce = null;
var peer0 = new Peer('grpc://localhost:7051');
var peer1 = new Peer('grpc://localhost:8051');
var peer2 = new Peer('grpc://localhost:9051');

var steps = [];
if (process.argv.length > 2) {
    for (let i = 2; i < process.argv.length; i++) {
        steps.push(process.argv[i]);
    }
}
var CHAINCODE_PATH = 'github.com/example_cc';
logger.info('Found steps: %s', steps);
//TODO: modify this based on the path ??
process.env.GOPATH = path.join(__dirname, 'test/fixtures');

chain.addOrderer(new Orderer('grpc://localhost:7050'));
chain.addPeer(peer0);
chain.addPeer(peer1);
chain.addPeer(peer2);

end2end();

function end2end() {

    hfc.newDefaultKeyValueStore({
        path: __dirname + 'keyValueStore'
    }).then(function(store) {
        client.setStateStore(store);
        //TODO: Should we avoid hardcoding and pass from config?
        var promise = getSubmitter('admin', 'adminpw', client);

        if (steps.length === 0 || steps.indexOf('step1') >= 0) {
            logger.info('Executing step1');
            promise = promise.then(
                function(admin) {
                    logger.info('Successfully enrolled user \'admin\'');
                    webUser = admin;
                    tx_id = utils.buildTransactionID({
                        length: 12
                    });
                    nonce = utils.getNonce();

                    // send proposal to endorser
                    var request = {
                        chaincodePath: CHAINCODE_PATH,
                        chaincodeId: chaincodeID,
                        fcn: 'init',
                        args: ['a', '100', 'b', '200'],
                        chainId: channelID,
                        txId: tx_id,
                        nonce: nonce,
                        'dockerfile-contents': 'from hyperledger/fabric-ccenv\n' +
                            'COPY . $GOPATH/src/build-chaincode/\n' +
                            'WORKDIR $GOPATH\n\n' +
                            'RUN go install build-chaincode && mv $GOPATH/bin/build-chaincode $GOPATH/bin/%s'
                    };

                    return chain.sendDeploymentProposal(request);
                },
                function(err) {
                    logger.error('Failed to enroll user \'admin\'. ' + err);
                    process.exit();
                }
            ).then(
                function(results) {
                    var proposalResponses = results[0];
                    //logger.debug('deploy proposalResponses:'+JSON.stringify(proposalResponses));
                    var proposal = results[1];
                    var header = results[2];
                    var all_good = true;
                    for (var i in proposalResponses) {
                        let one_good = false;
                        if (proposalResponses && proposalResponses[0].response && proposalResponses[0].response.status === 200) {
                            one_good = true;
                            logger.info('deploy proposal was good');
                        } else {
                            logger.error('deploy proposal was bad');
                        }
                        all_good = all_good & one_good;
                    }
                    if (all_good) {
                        logger.info(util.format('Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s", metadata - "%s", endorsement signature: %s', proposalResponses[0].response.status, proposalResponses[0].response.message, proposalResponses[0].response.payload, proposalResponses[0].endorsement.signature));
                        var request = {
                            proposalResponses: proposalResponses,
                            proposal: proposal,
                            header: header
                        };
                        return chain.sendTransaction(request);
                    } else {
                        logger.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
                        process.exit();
                    }
                },
                function(err) {
                    logger.error('Failed to send deployment proposal due to error: ' + err.stack ? err.stack : err);
                    process.exit();
                }
            );

            if (steps.length === 0) {
                // this is called without steps parameter in order to execute all steps
                // in sequence, will need to sleep for 30sec here
                promise = promise.then(
                    function(response) {
                        if (response.status === 'SUCCESS') {
                            logger.info('Successfully ordered deployment endorsement.');
                            console.log('  ** need to wait now for the committer to catch up after the deployment');
                            return sleep(30000);
                        } else {
                            logger.error('Failed to order the deployment endorsement. Error code: ' + response.status);
                            process.exit();
                        }

                    },
                    function(err) {
                        logger.error('Failed to send deployment e due to error: ' + err.stack ? err.stack : err);
                        process.exit();
                    }
                );
            } else if (steps.length === 1 && steps[0] === 'step1') {
                promise = promise.then(
                    function() {
                        process.exit();
                    }
                );
            }
        }

        if (steps.length === 0 || steps.indexOf('step2') >= 0) {
            promise = promise.then(
                function(data) {
                    logger.info('Executing step2');

                    // we may get to this point from the sleep() call above
                    // or from skipping step1 altogether. if coming directly
                    // to this step then "data" will be the webUser
                    if (typeof data !== 'undefined' && data !== null) {
                        webUser = data;
                    }

                    return Promise.resolve();
                }
            ).then(
                function() {
                    tx_id = utils.buildTransactionID({
                        length: 12
                    });
                    nonce = utils.getNonce();
                    // send proposal to endorser
                    var request = {
                        chaincodeId: chaincodeID,
                        fcn: 'invoke',
                        args: ['move', 'a', 'b', '100'],
                        chainId: channelID,
                        txId: tx_id,
                        nonce: nonce
                    };
                    return chain.sendTransactionProposal(request);
                },
                function(err) {
                    logger.error('Failed to wait due to error: ' + err.stack ? err.stack : err);
                    process.exit();
                }
            ).then(
                function(results) {
                    var proposalResponses = results[0];
                    var proposal = results[1];
                    var header = results[2];

                    var all_good = true;
                    for (var i in proposalResponses) {
                        let one_good = false;
                        if (proposalResponses && proposalResponses[i].response && proposalResponses[i].response.status === 200) {
                            one_good = true;
                            logger.info('move proposal was good');
                        } else {
                            logger.error('move proposal was bad');
                        }
                        all_good = all_good & one_good;
                    }
                    if (all_good) {
                        logger.info('Successfully obtained transaction endorsements.'); // + JSON.stringify(proposalResponses));
                        var request = {
                            proposalResponses: proposalResponses,
                            proposal: proposal,
                            header: header
                        };
                        return chain.sendTransaction(request);
                    } else {
                        logger.error('Failed to obtain transaction endorsements. Error code: ' + results);
                        process.exit();
                    }
                },
                function(err) {
                    logger.error('Failed to send transaction proposal due to error: ' + err.stack ? err.stack : err);
                    process.exit();
                }
            );

            if (steps.length === 0) {
                // this is called without steps parameter in order to execute all steps
                // in sequence, will need to sleep for 30sec here
                promise = promise.then(
                    function(response) {
                        if (response.status === 'SUCCESS') {
                            logger.info('Successfully ordered endorsement transaction.');
                        } else {
                            logger.error('Failed to order the endorsement of the transaction. Error code: ' + response.status);
                        }
                        // always sleep and check with query
                        console.log('  ** need to wait now for the committer to catch up after the **** MOVE ****');
                        return sleep(30000);
                    },
                    function(err) {
                        logger.error('Failed to send transaction proposal due to error: ' + err.stack ? err.stack : err);
                        process.exit();
                    }
                );
            } else if (steps.length >= 1 && steps[steps.length - 1] === 'step2') {
                promise = promise.then(
                    function() {
                        process.exit();
                    }
                );
            }
        }

        if (steps.length === 0 || steps.indexOf('step3') >= 0) {
            promise = promise.then(
                function(data) {
                    logger.info('Executing step3');

                    // we may get to this point from the sleep() call above
                    // or from skipping step1 altogether. if coming directly
                    // to this step then "data" will be the webUser
                    if (typeof data !== 'undefined' && data !== null) {
                        webUser = data;
                    }

                    return Promise.resolve();
                }
            ).then(
                function() {
                    // send query
                    var request = {
                        targets: [peer0, peer1, peer2],
                        chaincodeId: chaincodeID,
                        chainId: channelID,
                        txId: utils.buildTransactionID(),
                        nonce: utils.getNonce(),
                        fcn: 'invoke',
                        args: ['query', 'b']
                    };
                    return chain.queryByChaincode(request);
                },
                function(err) {
                    logger.error('Failed to wait-- error: ' + err.stack ? err.stack : err);
                    process.exit();
                }
            ).then(
                function(response_payloads) {
                    for (let i = 0; i < response_payloads.length; i++) {
                        logger.info('############### Query results after the move : User "b" now has  ' + response_payloads[i].toString('utf8'));
                    }
                    process.exit();
                },
                function(err) {
                    logger.error('Failed to send query due to error: ' + err.stack ? err.stack : err);
                    process.exit();
                }
            ).catch(
                function(err) {
                    logger.error('Failed to end to end test with error:' + err.stack ? err.stack : err);
                    process.exit();
                }
            );
        }
    });
}

function getSubmitter(username, password, client, loadFromConfig) {
    return client.getUserContext(username)
        .then((user) => {
            return new Promise((resolve, reject) => {
                if (user && user.isEnrolled()) {
                    logger.info('Successfully loaded member from persistence');
                    return resolve(user);
                } else {
                    if (!loadFromConfig) {
                        // need to enroll it with COP server
                        var cop = new copService('http://localhost:7054');

                        return cop.enroll({
                            enrollmentID: username,
                            enrollmentSecret: password
                        }).then((enrollment) => {
                            logger.info('Successfully enrolled user \'' + username + '\'');

                            var member = new User(username, client);
                            member.setEnrollment(enrollment.key, enrollment.certificate);
                            return resolve(client.setUserContext(member));
                        }).catch((err) => {
                            logger.error('Failed to enroll and persist user. Error: ' + err.stack ? err.stack : err);
                            process.exit();
                        });
                    } else {
                        // need to load private key and pre-enrolled certificate from files based on the MSP
                        // config directory structure:
                        // <config>
                        //    \_ keystore
                        //       \_ admin.pem  <<== this is the private key saved in PEM file
                        //    \_ signcerts
                        //       \_ admin.pem  <<== this is the signed certificate saved in PEM file

                        // first load the private key and save in the BCCSP's key store
                        var privKeyPEM = path.join(__dirname, 'test/fixtures/msp/keystore/admin.pem');
                        var pemData;
                        return readFile(privKeyPEM)
                            .then((data) => {
                                pemData = data;
                                // default crypto suite uses $HOME/.hfc-key-store as key store
                                var kspath = CryptoSuite.getKeyStorePath();
                                var testKey;
                                return new FileStore({
                                    path: kspath
                                });
                            }).then((store) => {
                                var rawKey = KEYUTIL.getKey(pemData.toString());
                                testKey = new ecdsaKey(rawKey, 256);
                                return store.setValue(testKey.getSKI(), pemData);
                            }).then((value) => {
                                // next save the certificate in a serialized user enrollment in the state store
                                var certPEM = path.join(__dirname, 'test/fixtures/msp/signcerts/admin.pem');
                                return readFile(certPEM);
                            }).then((data) => {
                                var member = new User(username, client);
                                member.setEnrollment(testKey, data.toString());
                                return client.setUserContext(member);
                            }).then((user) => {
                                return resolve(user);
                            }).catch((err) => {
                                reject(new Error('Failed to load key or certificate and save to local stores. ' + err));
                            });
                    }
                }
            });
        }).catch(
            function(err) {
                Promise.reject(err);
            }
        );
}

function readFile(path) {
    return new Promise((resolve, reject) => {
        fs.readFile(path, (err, data) => {
            if (!!err)
                reject(new Error('Failed to read file ' + path + ' due to error: ' + err));
            else
                resolve(data);
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
