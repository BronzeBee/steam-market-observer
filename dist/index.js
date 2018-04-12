'use strict';

var _winston = require('winston');

var _winston2 = _interopRequireDefault(_winston);

var _nodeFetch = require('node-fetch');

var _nodeFetch2 = _interopRequireDefault(_nodeFetch);

var _mongodb = require('mongodb');

var _nodeThrottledQueue = require('node-throttled-queue');

var _nodeThrottledQueue2 = _interopRequireDefault(_nodeThrottledQueue);

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

/**
 * Directory where log files are stored.
 * @type {string}
 */
const LOG_DIRECTORY = './logs';

/**
 * Configuration file path.
 * @type {string}
 */
const CONFIG_FILE = './config.json';

/**
 * Interval between requests to steam API.
 * Should be at least 10 seconds.
 * @type {number}
 */
const REQUEST_INTERVAL = 10000;

/**
 * Time to wait when 'too many requests' error is encountered.
 * @type {number}
 */
const REQUEST_COOL_DOWN = 30000;

/**
 * File which holds last update timestamp.
 * @type {string}
 */
const LAST_UPDATE_INFO_FILE = './last-update.txt';

/**
 * How many items are retrieved per request.
 * Maximum is 100, minimum is 1.
 * @type {number}
 */
const PAGE_SIZE = 100;

/**
 * List of properties available for item.
 * Note that price is included by default.
 * @type {Array}
 */
const ITEM_PROPERTIES = ["appid", "name", "icon_url", "sell_listings", "classid", "instanceid"];

const API_URL = 'https://steamcommunity.com/market/search/render/?query=&norender=1';

class SteamMarketObserver {

    constructor() {
        this.queue = new _nodeThrottledQueue2.default(REQUEST_INTERVAL, true, Promise);
        this.updateInterval = 0;
        this.lastUpdate = 0;

        this.config = null;
        this.db = null;
        this.collection = null;
        this.appIDs = null;

        // Use console until real logger is initialized
        this.logger = {
            info: console.log,
            error: console.error,
            warn: console.warn,
            debug: console.debug
        };
    }

    /**
     * Starts the updater.
     * @returns {Promise<void>}
     */
    start() {
        var _this = this;

        return _asyncToGenerator(function* () {
            try {
                _this.logger = _this.createLogger();
                _this.logger.info('--------------- Steam Market Observer v0.1.0 ---------------');
                _this.loadConfig();
                _this.readLastUpdateTime();
                yield _this.connectToDB();

                let delta = Date.now() - _this.lastUpdate;
                if (delta >= _this.updateInterval) {
                    yield _this.updateMarketListingsData();
                } else {
                    setTimeout(_this.updateMarketListingsData.bind(_this), _this.updateInterval - delta);
                }
            } catch (err) {
                _this.logger.error('Error encountered on startup:');
                _this.logger.error(String(err));
                if (_this.db) _this.db.close();
            }
        })();
    }

    /**
     * Establishes connection to MongoDB.
     * @returns {Promise<void>}
     */
    connectToDB() {
        var _this2 = this;

        return _asyncToGenerator(function* () {
            _this2.logger.info('Connecting to database');
            const database = yield _mongodb.MongoClient.connect(_this2.config['mongoDB']['url']);
            _this2.db = database.db(_this2.config['mongoDB']['name']);
            _this2.collection = _this2.db.collection(_this2.config['mongoDB']['collection']);
            _this2.logger.info('Successfully connected to database');
        })();
    }

    /**
     * Main updater function.
     * @returns {Promise<void>}
     */
    updateMarketListingsData() {
        var _this3 = this;

        return _asyncToGenerator(function* () {
            _this3.logger.info('Starting price update');
            try {
                yield _this3.fetchMarketData();
                _this3.lastUpdate = Date.now();
                _this3.writeLastUpdateTime();
                _this3.logger.info('Price update complete');
            } catch (err) {
                _this3.logger.error('Error encountered during price update');
                _this3.logger.error(String(err));
            }
            setTimeout(_this3.updateMarketListingsData.bind(_this3), _this3.updateInterval);
        })();
    }

    /**
     * Retrieves market listings details from Steam.
     * @returns {Promise<void>}
     */
    fetchMarketData() {
        var _this4 = this;

        return _asyncToGenerator(function* () {
            var _iteratorNormalCompletion = true;
            var _didIteratorError = false;
            var _iteratorError = undefined;

            try {
                for (var _iterator = _this4.appIDs[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                    let appID = _step.value;

                    _this4.logger.info(`Fetching prices for app ${appID}`);
                    let pageIndex = 1;
                    let total = 1;
                    let fetched = 0;
                    do {

                        // Make request to API
                        let response = yield _this4.queue.resolve(function () {
                            return (0, _nodeFetch2.default)(`${API_URL}&appid=${appID}` + `&start=${fetched}&count=${PAGE_SIZE}`);
                        });

                        if (response.status === 429) {
                            _this4.logger.warn('Made too many requests (429 status code)');
                            _this4.logger.warn(`Retrying in ${REQUEST_COOL_DOWN}ms`);
                            yield new Promise(function (resolve) {
                                return setTimeout(resolve, REQUEST_COOL_DOWN);
                            });
                            continue;
                        } else if (response.status !== 200) {
                            throw new Error(`Unable to fetch page #${pageIndex}: response code was ${response.status}`);
                        }

                        let page = yield response.json();
                        if (!page || Object.keys(page).length === 0) throw new Error('Response is empty');

                        if (!page.success) throw new Error(`Unable to fetch page #${pageIndex}`);

                        // Adjust total item counter
                        if (total !== page['total_count']) total = page['total_count'];

                        let results = page['results'];

                        // Save to DB
                        yield _this4.pushToDB(results);

                        fetched += results.length;
                        _this4.logger.info(`Fetched ${fetched} items of ${total}` + ` (${pageIndex} pages, ${Math.floor(fetched / total * 100)}%)`);
                        ++pageIndex;
                    } while (fetched < total);
                    _this4.logger.info(`Successfully fetched all prices for app ${appID}`);
                }
            } catch (err) {
                _didIteratorError = true;
                _iteratorError = err;
            } finally {
                try {
                    if (!_iteratorNormalCompletion && _iterator.return) {
                        _iterator.return();
                    }
                } finally {
                    if (_didIteratorError) {
                        throw _iteratorError;
                    }
                }
            }
        })();
    }

    /**
     * Saves items data to database.
     * @param items {Array.<string>} array of items from response page
     * @returns {Promise}
     */
    pushToDB(items) {
        var _this5 = this;

        return _asyncToGenerator(function* () {
            let bulk = _this5.collection.initializeUnorderedBulkOp();
            var _iteratorNormalCompletion2 = true;
            var _didIteratorError2 = false;
            var _iteratorError2 = undefined;

            try {
                for (var _iterator2 = items[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
                    let item = _step2.value;

                    let toSet = { sell_price: item['sell_price'] };

                    var _iteratorNormalCompletion3 = true;
                    var _didIteratorError3 = false;
                    var _iteratorError3 = undefined;

                    try {
                        for (var _iterator3 = ITEM_PROPERTIES[Symbol.iterator](), _step3; !(_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done); _iteratorNormalCompletion3 = true) {
                            let prop = _step3.value;

                            if (_this5.config['properties'].includes(prop)) toSet[prop] = item[prop] !== undefined ? item[prop] : item['asset_description'][prop];
                        }
                    } catch (err) {
                        _didIteratorError3 = true;
                        _iteratorError3 = err;
                    } finally {
                        try {
                            if (!_iteratorNormalCompletion3 && _iterator3.return) {
                                _iterator3.return();
                            }
                        } finally {
                            if (_didIteratorError3) {
                                throw _iteratorError3;
                            }
                        }
                    }

                    bulk.find({ hash_name: item['hash_name'] }).upsert().updateOne({ $set: toSet });
                }
            } catch (err) {
                _didIteratorError2 = true;
                _iteratorError2 = err;
            } finally {
                try {
                    if (!_iteratorNormalCompletion2 && _iterator2.return) {
                        _iterator2.return();
                    }
                } finally {
                    if (_didIteratorError2) {
                        throw _iteratorError2;
                    }
                }
            }

            return bulk.execute();
        })();
    }

    /**
     * Initializes winston logger.
     * @returns {*}
     */
    createLogger() {

        let formatter = args => {
            return `[${new Date().toISOString()} ${args.level.toUpperCase()}] ${args.message}`;
        };

        // Create log directory if it doesn't exist
        if (!_fs2.default.existsSync(LOG_DIRECTORY)) _fs2.default.mkdirSync(LOG_DIRECTORY);

        // Find latest log file
        let matchingFiles = _fs2.default.readdirSync(LOG_DIRECTORY).filter(file => !_fs2.default.statSync(LOG_DIRECTORY + '/' + file).isDirectory() && file.startsWith('latest_') && file.endsWith('.log'));

        if (matchingFiles.length > 0) {
            // And rename it
            let file = matchingFiles[0];
            _fs2.default.renameSync(LOG_DIRECTORY + '/' + file, LOG_DIRECTORY + '/' + file.replace('latest_', ''));
        }

        // Forms log file name
        let simpleDateString = new Date().toISOString().replace(/:/g, '-').replace('T', '_').split('.')[0];
        return new _winston2.default.Logger({
            json: false,
            transports: [new _winston2.default.transports.Console({
                level: 'info',
                handleExceptions: true,
                json: false,
                formatter: formatter
            }), new _winston2.default.transports.File({
                level: 'info',
                filename: LOG_DIRECTORY + '/latest_' + simpleDateString + '.log',
                handleExceptions: true,
                json: false,
                formatter: formatter
            })]
        });
    }

    /**
     * Saves last update timestamp to file.
     */
    writeLastUpdateTime() {
        this.logger.info('Writing last price update time');
        try {
            _fs2.default.writeFileSync(LAST_UPDATE_INFO_FILE, String(this.lastUpdate), 'utf-8');
        } catch (err) {
            this.logger.error('Unable to write update time');
            this.logger.error(err);
        }
    }

    /**
     * Loads last update timestamp from file.
     */
    readLastUpdateTime() {
        this.logger.info('Reading last price update time');
        let lastUpdate = 0;
        if (_fs2.default.existsSync(LAST_UPDATE_INFO_FILE)) lastUpdate = parseInt(_fs2.default.readFileSync(LAST_UPDATE_INFO_FILE, 'utf-8'), 10);else _fs2.default.writeFileSync(LAST_UPDATE_INFO_FILE, String(lastUpdate), 'utf-8');
        this.lastUpdate = lastUpdate;
        if (this.lastUpdate === 0) this.logger.info('No price update information found');else this.logger.info(`Last updated price database on ${new Date(this.lastUpdate).toISOString()}`);
    }

    /**
     * Loads the configuration file.
     */
    loadConfig() {
        this.logger.info('Loading configuration file');
        this.config = JSON.parse(_fs2.default.readFileSync(CONFIG_FILE, 'utf-8'));
        this.updateInterval = this.config['updateInterval'];
        this.appIDs = this.config['apps'];
        this.logger.info('Configuration loaded successfully');
    }

}

// Start the script
new SteamMarketObserver().start();