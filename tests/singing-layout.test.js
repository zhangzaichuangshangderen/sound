'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/singing/index.ts'), 'utf8')
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

test('音高轨迹支持双指缩放并保留单指拖动', () => {
  assert.match(wxml, /双指捏合缩放，单指左右拖动查看历史/)
  assert.match(source, /chartPinchStartDistance/)
  assert.match(source, /chartTouchDistance\(touches\)/)
  assert.match(source, /Math\.max\(0\.75, Math\.min\(4, this\.chartPinchStartZoom/)
})

test('音高轨迹保留完整自然音刻度，并使用紧凑样式避免重叠', () => {
  assert.match(source, /const naturalPitchClasses = \[0, 2, 4, 5, 7, 9, 11\]/)
  assert.match(wxss, /\.chart-axis-label.*font-size: 16rpx/)
})
