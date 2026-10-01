'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const wxml = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/singing/index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/singing/index.wxss'), 'utf8')

test('跟练选择区使用可换行三列布局且不依赖 Grid', () => {
  assert.match(wxss, /\.note-grid\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/s)
  assert.match(wxss, /flex:\s*0 0 calc\(\(100% - 24rpx\) \/ 3\)/)
  assert.doesNotMatch(wxss, /\.note-grid\s*\{[^}]*display:\s*grid;/s)
})

test('最后一个音名居中且选择结果不再重复占用一整行', () => {
  assert.match(wxml, /item === 'B' \? 'last-note'/)
  assert.match(wxss, /\.note-name-row \.note-choice\.last-note/)
  assert.doesNotMatch(wxml, /class="selected-note"/)
})

test('试听和开始按钮位于统一的全宽操作容器', () => {
  assert.match(wxml, /class="action-stack"/)
  assert.match(wxss, /\.action-stack button\s*\{[^}]*width:\s*100%;/s)
})
