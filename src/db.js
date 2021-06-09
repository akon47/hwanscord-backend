const mongoose = require('mongoose')
module.exports = () => {
    const connect = () => {
        mongoose.connect('mongodb://hwans:hwans@mongo/hwanscord', function(err) {
            if(err) {
                console.error('mongodb connection error', err);
                process.exit(1); // restart server by docker-compose
            } else {
                console.log('mongodb connected');
            }
        });
        mongoose.Promise = global.Promise;
    }   
    connect();
    require('./models/UserModel.js');
}