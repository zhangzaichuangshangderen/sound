'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const wxml = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/index/index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/index/index.wxss'), 'utf8')

test('乐理进度不在 WXML 内联样式中执行模板算术', () => {
  assert.doesNotMatch(wxml, /style="[^"]*theoryProgress/)
  assert.match(wxml, /class="progress-value progress-level-\{\{theoryProgress\}\}"/)
})

test('乐理进度为 0 到 8 节提供确定的宽度样式', () => {
  for (let level = 0; level <= 8; level++) {
    assert.match(wxss, new RegExp(`\\.progress-level-${level}\\s*\\{[^}]*width:`))
  }
})
