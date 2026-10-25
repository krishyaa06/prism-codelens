#!/usr/bin/env node
'use strict';
const { main } = require('../src/cli');
const c = require('../src/colors');

main().then(code => { process.exitCode = code; }).catch(err => {
    console.error(`\n  ${c.red('✖ ' + err.message)}\n`);
    process.exitCode = 2;
});
