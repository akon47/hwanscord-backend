const redis = require('redis');

const redisClient = redis.createClient({
  host: 'redis-server',
  port: 6379,
});

redisClient.flushall();

console.log('redis init...');

module.exports = {
  increaseConnection: (userid) => {
    return new Promise((resolve) => {
      redisClient.incr(userid, (err, number) => {
        resolve(number);
      });
    });
    //return redisClient.incr(userid);
  },
  decreaseConnection: (userid) => {
    return new Promise((resolve) => {
      redisClient.decr(userid, (err, number) => {
        resolve(number);
      });
    });
    //return redisClient.decr(userid);
  },
  getConnections: (userid) => {
    return new Promise((resolve) => {
      redisClient.get(userid, (err, number) => {
        resolve(number);
      });
    });
    //return redisClient.get(userid);
  },
};
