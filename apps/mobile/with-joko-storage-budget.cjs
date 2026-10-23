const { withGradleProperties } = require("expo/config-plugins");

const PROPERTY_KEY = "AsyncStorage_db_size_in_MB";
const DATABASE_SIZE_MB = 64;

function setMobileStorageBudget(properties) {
  const existing = properties.find(item => item.type === "property" && item.key === PROPERTY_KEY);
  if (existing) existing.value = String(DATABASE_SIZE_MB);
  else properties.push({ type: "property", key: PROPERTY_KEY, value: String(DATABASE_SIZE_MB) });
  return properties;
}

function withJokoStorageBudget(config) {
  return withGradleProperties(config, android => {
    android.modResults = setMobileStorageBudget(android.modResults);
    return android;
  });
}

module.exports = withJokoStorageBudget;
module.exports.setMobileStorageBudget = setMobileStorageBudget;
