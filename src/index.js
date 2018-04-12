import winston from 'winston';
import fetch from 'node-fetch';
import {MongoClient} from 'mongodb';
import ThrottledQueue from 'node-throttled-queue';
import fs from 'fs';

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
const ITEM_PROPERTIES = [
    "appid",
    "name",
    "icon_url",
    "sell_listings",
    "classid",
    "instanceid"
];

const API_URL = 'https://steamcommunity.com/market/search/render/?query=&norender=1';

class SteamMarketObserver {

    constructor() {
        this.queue = new ThrottledQueue(REQUEST_INTERVAL, true, Promise);
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
    async start() {
        try {
            this.logger = this.createLogger();
            this.logger.info('--------------- Steam Market Observer v0.1.0 ---------------');
            this.loadConfig();
            this.readLastUpdateTime();
            await this.connectToDB();

            let delta = Date.now() - this.lastUpdate;
            if (delta >= this.updateInterval) {
                await this.updateMarketListingsData();
            } else {
                setTimeout(this.updateMarketListingsData.bind(this), this.updateInterval - delta);
            }
        } catch (err) {
            this.logger.error('Error encountered on startup:');
            this.logger.error(String(err));
            if (this.db)
                this.db.close();
        }
    }

    /**
     * Establishes connection to MongoDB.
     * @returns {Promise<void>}
     */
    async connectToDB() {
        this.logger.info('Connecting to database');
        const database = await MongoClient.connect(this.config['mongoDB']['url']);
        this.db = database.db(this.config['mongoDB']['name']);
        this.collection = this.db.collection(this.config['mongoDB']['collection']);
        this.logger.info('Successfully connected to database');
    }

    /**
     * Main updater function.
     * @returns {Promise<void>}
     */
    async updateMarketListingsData() {
        this.logger.info('Starting price update');
        try {
            await this.fetchMarketData();
            this.lastUpdate = Date.now();
            this.writeLastUpdateTime();
            this.logger.info('Price update complete');
        } catch (err) {
            this.logger.error('Error encountered during price update');
            this.logger.error(String(err));
        }
        setTimeout(this.updateMarketListingsData.bind(this), this.updateInterval);
    }

    /**
     * Retrieves market listings details from Steam.
     * @returns {Promise<void>}
     */
    async fetchMarketData() {
        for (let appID of this.appIDs) {
            this.logger.info(`Fetching prices for app ${appID}`);
            let pageIndex = 1;
            let total = 1;
            let fetched = 0;
            do {

                // Make request to API
                let response = await this.queue.resolve(() => fetch(`${API_URL}&appid=${appID}`
                    + `&start=${fetched}&count=${PAGE_SIZE}`));

                if (response.status === 429) {
                    this.logger.warn('Made too many requests (429 status code)');
                    this.logger.warn(`Retrying in ${REQUEST_COOL_DOWN}ms`);
                    await new Promise(resolve => setTimeout(resolve, REQUEST_COOL_DOWN));
                    continue;
                } else if (response.status !== 200) {
                    throw new Error(`Unable to fetch page #${pageIndex}: response code was ${response.status}`);
                }

                let page = await response.json();
                if (!page || Object.keys(page).length === 0)
                    throw new Error('Response is empty');

                if (!page.success)
                    throw new Error(`Unable to fetch page #${pageIndex}`);

                // Adjust total item counter
                if (total !== page['total_count'])
                    total = page['total_count'];

                let results = page['results'];

                // Save to DB
                await this.pushToDB(results);

                fetched += results.length;
                this.logger.info(`Fetched ${fetched} items of ${total}`
                    + ` (${pageIndex} pages, ${Math.floor((fetched / total) * 100)}%)`);
                ++pageIndex;
            } while (fetched < total);
            this.logger.info(`Successfully fetched all prices for app ${appID}`);
        }
    }

    /**
     * Saves items data to database.
     * @param items {Array.<string>} array of items from response page
     * @returns {Promise}
     */
    async pushToDB(items) {
        let bulk = this.collection.initializeUnorderedBulkOp();
        for (let item of items) {
            let toSet = {sell_price: item['sell_price']};

            for (let prop of ITEM_PROPERTIES) {
                if (this.config['properties'].includes(prop))
                    toSet[prop] = item[prop] !== undefined ? item[prop] : item['asset_description'][prop];
            }

            bulk.find({hash_name: item['hash_name']}).upsert().updateOne({$set: toSet});
        }
        return bulk.execute();
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
        if (!fs.existsSync(LOG_DIRECTORY))
            fs.mkdirSync(LOG_DIRECTORY);

        // Find latest log file
        let matchingFiles = fs.readdirSync(LOG_DIRECTORY).filter(file =>
            !fs.statSync(LOG_DIRECTORY + '/' + file).isDirectory()
            && file.startsWith('latest_')
            && file.endsWith('.log'));

        if (matchingFiles.length > 0) {
            // And rename it
            let file = matchingFiles[0];
            fs.renameSync(LOG_DIRECTORY + '/' + file, LOG_DIRECTORY + '/' + file.replace('latest_', ''));
        }

        // Forms log file name
        let simpleDateString = new Date().toISOString().replace(/:/g, '-').replace('T', '_').split('.')[0];
        return new winston.Logger({
            json: false,
            transports: [
                new (winston.transports.Console)({
                    level: 'info',
                    handleExceptions: true,
                    json: false,
                    formatter: formatter
                }),
                new (winston.transports.File)({
                    level: 'info',
                    filename: LOG_DIRECTORY + '/latest_' + simpleDateString + '.log',
                    handleExceptions: true,
                    json: false,
                    formatter: formatter
                })
            ]
        });
    }

    /**
     * Saves last update timestamp to file.
     */
    writeLastUpdateTime() {
        this.logger.info('Writing last price update time');
        try {
            fs.writeFileSync(LAST_UPDATE_INFO_FILE, String(this.lastUpdate), 'utf-8');
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
        if (fs.existsSync(LAST_UPDATE_INFO_FILE))
            lastUpdate = parseInt(fs.readFileSync(LAST_UPDATE_INFO_FILE, 'utf-8'), 10);
        else
            fs.writeFileSync(LAST_UPDATE_INFO_FILE, String(lastUpdate), 'utf-8');
        this.lastUpdate = lastUpdate;
        if (this.lastUpdate === 0)
            this.logger.info('No price update information found');
        else
            this.logger.info(`Last updated price database on ${new Date(this.lastUpdate).toISOString()}`);
    }

    /**
     * Loads the configuration file.
     */
    loadConfig() {
        this.logger.info('Loading configuration file');
        this.config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        this.updateInterval = this.config['updateInterval'];
        this.appIDs = this.config['apps'];
        this.logger.info('Configuration loaded successfully');
    }

}

// Start the script
new SteamMarketObserver().start();