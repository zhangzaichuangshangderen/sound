'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const wxml = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/index/index.wxml'), 'utf8')
const wxss = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/index/index.wxss'), 'utf8')
const source = fs.readFileSync(path.join(projectRoot, 'miniprogram/pages/index/index.ts'), 'utf8')

test('乐器首页不再渲染冗余标题与副标题', () => {
  assert.doesNotMatch(wxml, /instrument-home-heading/)
  assert.doesNotMatch(wxml, /练习工具/)
})

test('节拍器使用独立导航栈，交给微信原生左上返回按钮', () => {
  assert.match(source, /app\.globalData\.openMetronomeRoute = true/)
  assert.match(source, /wx\.navigateTo\(\{\n\s*url: '\/pages\/index\/index'/)
  assert.match(source, /wx\.setNavigationBarTitle\(\{ title: '节拍器' \}\)/)
  assert.match(source, /if \(pages\.length > 1\) \{\n\s*wx\.navigateBack\(\)/)
  assert.doesNotMatch(wxml, /metronome-detail-heading|detail-back/)
  assert.doesNotMatch(wxss, /\.metronome-detail-heading|\.detail-back/)
})
