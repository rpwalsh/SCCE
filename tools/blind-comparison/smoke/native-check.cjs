const assert = require('node:assert/strict');
const add = require('./module.cjs');
for (const [a, b] of [[2, 3], [-5, 2], [0, 0], [1.5, -0.25]]) assert.equal(add(a, b), a + b);
