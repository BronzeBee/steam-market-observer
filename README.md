# Steam Market Observer

Node.js appliction that allows to maintain up-to-date Steam Market prices within MongoDB database on your server.
_WARNING: This application uses undocumented API methods & can break at any time._
## Installation

```
npm install -P git+https://github.com/BronzeBee/steam-market-observer.git
```
## Configuration
Configuration is stored in [config.json](config.json) file.
Default configuration file looks like this:
```json
{
  "updateInterval": 1800000,
  "apps": [578080],
  "properties": ["appid", "name", "icon_url", "sell_listings", "classid", "instanceid"],
  "mongoDB": {
    "url": "mongodb://localhost:27017",
    "name": "test",
    "collection": "market"
  }
}
```
Where:
* **updateInterval** - interval between price database updates in milliseconds; make sure you set it big enough as getting prices of all CS:GO or DOTA 2 items will take 25-40 minutes.
* **apps** - array of Steam App IDs market listings from which should be saved. (You can get appID of any game at [SteamDB](https://steamdb.info/apps/))
* **properties** - list of data that should be saved for each item; _sell_price_ (**in US cents**) & _hash_name_ are included by default. Obtained values are stored in the corresponding fields of DB document, so you can remove the ones you do not need in order to save disk space. Available fields are:
  * _appid_ - ID of Steam app item belongs to
  * _name_ - display name of the item
  * _icon_url_ - url to item image
  * _sell_listings_ - number of items available on Steam Market
  * _classid_ - item's classID
  * _instanceid_ - item's instnaceID
* **mongoDB** - MongoDB connection & database details:
  * _url_ - connection URL
  * _name_ - databse name
  * _collection_ - collection name

## Usage

Start the app using ``npm start``.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

