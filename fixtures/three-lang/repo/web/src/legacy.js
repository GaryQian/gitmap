const { formatDate } = require('./util');

module.exports = function stamp() {
  return formatDate(new Date());
};
