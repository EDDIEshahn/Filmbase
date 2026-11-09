const fs = require('fs');
const path = require('path');

// Simple JSON-file database. Fine for a single server and small catalogs.
// For multiple servers or heavy traffic, move to PostgreSQL or similar.
function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { users: [], titles: [], payments: [] };

  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };

  if (!fs.existsSync(file)) save();
  return { data, save };
}

module.exports = { createStore };
