const path = require('path');
const fs = require('fs');

const spdy = require('spdy');
const httpProxy = require('http-proxy');
const request = require('request');
const PromisePool = require('es6-promise-pool');

const BITCOIND_PORT_FRONT = 18333;
const BITCOIND_PORT_BACK = 18332;
const COUNTERPARTYLIB_PORT_FRONT = 14001;
const COUNTERPARTYLIB_PORT_BACK = 14000;

const _requestCerts = () => new Promise((accept, reject) => {
  if (process.argv.length === 3) {
    const certPath = process.argv[2];

    const _readFile = (p, opts) => new Promise((accept, reject) => {
      fs.readFile(p, opts, (err, d) => {
        if (!err) {
          accept(d);
        } else {
          reject(err);
        }
      });
    });

    Promise.all([
      _readFile(path.join(certPath, 'cert.pem'), 'utf8'),
      _readFile(path.join(certPath, 'private.pem'), 'utf8'),
    ])
      .then(([
        cert,
        privateKey,
      ]) => ({
        cert,
        privateKey,
      }))
      .then(accept)
      .catch(reject);
  } else {
    const err = new Error('expected 1 argument');
    reject(err);
  }
});
const _initBitcoindServer = certs => new Promise((accept, reject) => {
  const _requestUtxos = address => new Promise((accept, reject) => {
    request({
      method: 'POST',
      url: `http://localhost:${BITCOIND_PORT_BACK}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + new Buffer('backenduser:backendpassword', 'utf8').toString('base64'),
      },
      body: {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "searchrawtransactions",
        "params": [
          address,
          1,
          0,
          9999999
        ]
      },
      json: true,
    }, (err, res, body) => {
      if (!err) {
        if (!body.error) {
          accept(body.result);
        } else {
          const err = new Error(JSON.stringify(body.error));
          reject(err);
        }
      } else {
        reject(err);
      }
    });
  })
    .then(txs => {
      let i = 0;
      let j = 0;
      const pool = new PromisePool(() => {
        for (;;) {
          if (i < txs.length) {
            const tx = txs[i];

            if (j < tx.vout.length) {
              const oldJ = j;
              j++;
              return _requestGetTxOut(address, tx.txid, oldJ);
            } else {
              i++;
              j = 0;

              continue;
            }
          } else {
            return null;
          }
        }
      }, 8);

      return pool.start()
        .then(txouts => txouts.filter(txout => !!txout));
    });
  const _requestGetTxOut = (address, txid, vout) => new Promise((accept, reject) => {
    request({
      method: 'POST',
      url: `http://localhost:${BITCOIND_PORT_BACK}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + new Buffer('backenduser:backendpassword', 'utf8').toString('base64'),
      },
      body: {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "gettxout",
        "params": [
          txid,
          vout,
        ]
      },
      json: true,
    }, (err, res, body) => {
      if (!body.error) {
        accept(body.result);
      } else {
        const err = new Error(JSON.stringify(body.error));
        reject(err);
      }
    })
  })
  .then(txout => {
    if (txout) {
      if (txout.scriptPubKey.addresses && txout.scriptPubKey.addresses.includes(address)) {
        return {
          txid: txid,
          vout: vout,
          address: address,
          account: '',
          scriptPubKey: txout.scriptPubKey.hex,
          confirmations: txout.confirmations,
          amount: txout.value,
          satoshis: txout.value * 1e8,
          spendable: true,
          solvable: true,
        };
      } else {
        return null;
      }
    } else {
      return null;
    }
  });
  const _requestSend = tx => new Promise((accept, reject) => {
    request({
      method: 'POST',
      url: `http://localhost:${BITCOIND_PORT_BACK}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + new Buffer('backenduser:backendpassword', 'utf8').toString('base64'),
      },
      body: {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "sendrawtransaction",
        "params": [
          tx,
        ]
      },
      json: true,
    }, (err, res, body) => {
      if (!body.error) {
        accept(body.result);
      } else {
        const err = new Error(JSON.stringify(body.error));
        reject(err);
      }
    })
  })

  const server = spdy.createServer({
    cert: certs.cert,
    key: certs.privateKey,
  }, (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.end();
    } else {
      let match;
      if (req.method === 'GET' && (match = req.url.match(/^\/listunspent\/(.+)$/))) {
        const address = match[1];

        _requestUtxos(address)
          .then(utxos => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(utxos));
          })
          .catch(err => {
            res.statusCode = 500;
            res.end(err.stack);
          });
      } else if (req.method === 'GET' && (match = req.url.match(/^\/balance\/(.+)$/))) {
        const address = match[1];

        _requestUtxos(address)
          .then(utxos => {
            let balance = 0;
            for (let i = 0; i < utxos.length; i++) {
              const utxo = utxos[i];

              if (utxo.confirmations > 0) {
                balance += utxo.satoshis;
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              balance,
            }));
          })
          .catch(err => {
            res.statusCode = 500;
            res.end(err.stack);
          });
      } else if (req.method === 'GET' && (match = req.url.match(/^\/unconfirmedbalance\/(.+)$/))) {
        const address = match[1];

        _requestUtxos(address)
          .then(utxos => {
            let balance = 0;
            for (let i = 0; i < utxos.length; i++) {
              const utxo = utxos[i];
              balance += utxo.satoshis;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              balance,
            }));
          })
          .catch(err => {
            res.statusCode = 500;
            res.end(err.stack);
          });
      } else if (req.method === 'POST' && req.url === '/send') {
        const bs = [];

        req.on('data', d => {
          bs.push(d);
        });
        req.on('end', () => {
          const b = Buffer.concat(bs);
          const s = b.toString('utf8');
          const j = _jsonParse(s);

          if (typeof j === 'object' && j && typeof j.tx === 'string') {
            const {tx} = j;

            _requestSend(tx)
              .then(txid => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                  txid,
                }));
              })
              .catch(err => {
                res.statusCode = 500;
                res.end(err.stack);
              });
          } else {
            res.statusCode = 400;
            res.end();
          }
        });
      } else {
        proxy.web(req, res, err => {
          if (err) {
            res.statusCode = 500;
            res.end(err.stack);
          }
        });
      }
    }
  });

  const proxy = httpProxy.createProxyServer({
    target: `http://localhost:${BITCOIND_PORT_BACK}`,
  });
  server.listen(BITCOIND_PORT_FRONT, err => {
    if (!err) {
      accept();
    } else {
      reject(err);
    }
  });
});
const _initCounterpartyLibServer = certs => new Promise((accept, reject) => {
  const server = spdy.createServer({
    cert: certs.cert,
    key: certs.privateKey,
  }, (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.end();
    } else {
      proxy.web(req, res, err => {
        if (err) {
          res.statusCode = 500;
          res.end(err.stack);
        }
      });
    }
  });

  const proxy = httpProxy.createProxyServer({
    target: `http://localhost:${COUNTERPARTYLIB_PORT_BACK}`,
  });
  server.listen(COUNTERPARTYLIB_PORT_FRONT, err => {
    if (!err) {
      accept();
    } else {
      reject(err);
    }
  });
});

const _jsonParse = s => {
  let error = null;
  let result;
  try {
    result = JSON.parse(s);
  } catch (err) {
    error = err;
  }
  if (!error) {
    return result;
  } else {
    return undefined;
  }
};

_requestCerts()
  .then(certs => Promise.all([
    _initBitcoindServer(certs),
    _initCounterpartyLibServer(certs),
  ]))
  .then(() => {
    console.log('listening');
  })
  .catch(err => {
    console.warn(err);
  });
