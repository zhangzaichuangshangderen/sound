type TabKey = 'sing' | 'instrument' | 'theory' | 'practice' | 'me'

let metronomeTimer: ReturnType<typeof setInterval> | null = null
let countInTimer: ReturnType<typeof setInterval> | null = null
let metronomeContext: any = null

Component({
  data: {
    activeTab: 'sing' as TabKey,
    instrumentView: 'home' as 'home' | 'metronome',
    tabs: [
      { key: 'sing', label: '唱', icon: '/assets/tabbar/sing.png' },
      { key: 'instrument', label: '乐器', icon: '/assets/tabbar/instrument.png' },
      { key: 'theory', label: '乐理', icon: '/assets/tabbar/theory.png' },
      { key: 'practice', label: '练习', icon: '/assets/tabbar/practice.png' },
      { key: 'me', label: '我的', icon: '/assets/tabbar/me.png' },
    ],
    beatOptions: [1, 2, 3, 4],
    timeSignatures: [
      { label: '2/4', beats: 2 },
      { label: '3/4', beats: 3 },
      { label: '4/4', beats: 4 },
      { label: '6/8', beats: 6 },
    ],
    toneOptions: [
      { key: 'classic', label: '清脆' },
      { key: 'wood', label: '木质' },
      { key: 'soft', label: '柔和' },
    ],
    theoryProgress: 2,
    metronomePlaying: false,
    countInActive: false,
    countInEnabled: true,
    countInCountdown: 0,
    bpm: 80,
    beat: 0,
    beatsPerMeasure: 4,
    timeSignature: '4/4',
    metronomeTone: 'classic',
    metronomeVolume: 70,
    pendulumDuration: 750,
    practiceMinutes: 0,
    practiceDays: 0,
    feedbackMode: '温和',
  },
  lifetimes: {
    attached() {
      this.loadStats()
      const wxAudio = wx as any
      metronomeContext = typeof wxAudio.createWebAudioContext === 'function' ? wxAudio.createWebAudioContext() : null
    },
    detached() { this.stopMetronome(); if (metronomeContext && metronomeContext.close) metronomeContext.close(); metronomeContext = null },
  },
  pageLifetimes: {
    show() { this.loadStats() },
    hide() { this.stopMetronome() },
  },
  methods: {
    loadStats() { const stats = wx.getStorageSync('leta-stats') || {}; const feedbackMode = wx.getStorageSync('leta-feedback-mode') || '温和'; this.setData({ practiceMinutes: stats.practiceMinutes || 0, practiceDays: stats.practiceDays || 0, theoryProgress: stats.theoryProgress || 2, feedbackMode }) },
    switchTab(e: any) {
      const key = e.currentTarget.dataset.key as TabKey
      if (key === 'theory' || key === 'practice' || key === 'me') {
        wx.showToast({ title: key === 'theory' ? '开放中' : '开发中', icon: 'none' })
        return
      }
      if (key !== 'instrument' || this.data.instrumentView === 'metronome') this.stopMetronome()
      this.setData({ activeTab: key, instrumentView: key === 'instrument' ? 'home' : this.data.instrumentView })
    },
    startSinging() { this.stopMetronome(); wx.navigateTo({ url: '../singing/index?mode=scale' }) },
    startSingle() { this.stopMetronome(); wx.navigateTo({ url: '../singing/index?mode=single' }) },
    openMetronome() { this.setData({ activeTab: 'instrument', instrumentView: 'metronome' }) },
    backToInstrumentHome() { this.stopMetronome(); this.setData({ instrumentView: 'home' }) },
    openTheory() { this.setData({ activeTab: 'theory' }) },
    toggleMetronome() { this.data.metronomePlaying || this.data.countInActive ? this.stopMetronome() : this.startMetronome() },
    resumeMetronomeContext() {
      if (!metronomeContext) {
        const wxAudio = wx as any
        metronomeContext = typeof wxAudio.createWebAudioContext === 'function' ? wxAudio.createWebAudioContext() : null
      }
      if (!metronomeContext) {
        wx.showToast({ title: '当前微信版本不支持节拍器声音', icon: 'none' })
        return false
      }
      if (!metronomeContext.resume) return true
      const resumeResult = metronomeContext.resume()
      if (resumeResult && typeof resumeResult.catch === 'function') resumeResult.catch((error: any) => console.error('节拍器音频启动失败', error))
      return true
    },
    startMetronome() {
      this.stopMetronome()
      if (!this.resumeMetronomeContext()) return
      if (this.data.countInEnabled) {
        this.startCountIn()
        return
      }
      this.beginMetronome()
    },
    startCountIn() {
      let remaining = this.data.beatsPerMeasure
      const interval = 60000 / this.data.bpm
      this.setData({ countInActive: true, countInCountdown: remaining, metronomePlaying: false, beat: 0 })
      this.playMetronomeTone(true, true)
      countInTimer = setInterval(() => {
        remaining--
        if (remaining <= 0) {
          if (countInTimer) clearInterval(countInTimer)
          countInTimer = null
          this.beginMetronome()
          return
        }
        this.setData({ countInCountdown: remaining })
        this.playMetronomeTone(false, true)
      }, interval)
    },
    beginMetronome() {
      this.setData({ countInActive: false, countInCountdown: 0, metronomePlaying: true, beat: 0 })
      this.tickMetronome()
      metronomeTimer = setInterval(() => this.tickMetronome(), 60000 / this.data.bpm)
    },
    stopMetronome() {
      if (metronomeTimer) clearInterval(metronomeTimer)
      if (countInTimer) clearInterval(countInTimer)
      metronomeTimer = null
      countInTimer = null
      this.setData({ metronomePlaying: false, countInActive: false, countInCountdown: 0, beat: 0 })
    },
    restartMetronomeWithoutCountIn() {
      const shouldRestart = this.data.metronomePlaying || this.data.countInActive
      this.stopMetronome()
      if (shouldRestart) {
        if (!this.resumeMetronomeContext()) return
        this.beginMetronome()
      }
    },
    tickMetronome() {
      const beat = this.data.beat % this.data.beatsPerMeasure + 1
      this.setData({ beat })
      if (beat === 1) wx.vibrateShort({ type: 'light' })
      this.playMetronomeTone(beat === 1)
    },
    playMetronomeTone(accent: boolean, countIn = false) {
      if (!metronomeContext) return
      try {
        const toneMap: Record<string, { type: string; high: number; low: number; duration: number; level: number }> = {
          classic: { type: 'sine', high: 1120, low: 760, duration: 0.055, level: 1 },
          wood: { type: 'square', high: 880, low: 620, duration: 0.035, level: 0.55 },
          soft: { type: 'triangle', high: 720, low: 520, duration: 0.09, level: 0.72 },
        }
        const tone = toneMap[this.data.metronomeTone] || toneMap.classic
        const now = metronomeContext.currentTime
        const oscillator = metronomeContext.createOscillator()
        const gain = metronomeContext.createGain()
        oscillator.type = tone.type
        oscillator.frequency.value = accent ? tone.high : tone.low
        const volume = Math.max(0, Math.min(1, this.data.metronomeVolume / 100))
        const baseLevel = accent ? 0.24 : 0.13
        gain.gain.setValueAtTime(Math.max(0.0001, baseLevel * tone.level * volume * (countIn ? 0.82 : 1)), now)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.duration)
        oscillator.connect(gain)
        gain.connect(metronomeContext.destination)
        oscillator.start(now)
        oscillator.stop(now + tone.duration + 0.01)
      } catch (error) {
        console.error('节拍器发声失败', error)
        this.stopMetronome()
        wx.showToast({ title: '节拍器声音启动失败', icon: 'none' })
      }
    },
    changeBpmFromSlider(e: any) {
      const bpm = Number(e.detail.value)
      this.setData({ bpm, pendulumDuration: Math.round(60000 / bpm) })
    },
    commitBpm() { this.restartMetronomeWithoutCountIn() },
    selectTimeSignature(e: any) {
      const beats = Number(e.currentTarget.dataset.beats)
      const label = String(e.currentTarget.dataset.label)
      if (!Number.isFinite(beats) || beats < 1) return
      this.setData({ timeSignature: label, beatsPerMeasure: beats, beatOptions: Array.from({ length: beats }, (_, index) => index + 1) })
      this.restartMetronomeWithoutCountIn()
    },
    selectTone(e: any) { this.setData({ metronomeTone: String(e.currentTarget.dataset.tone) }) },
    changeVolume(e: any) { this.setData({ metronomeVolume: Number(e.detail.value) }) },
    toggleCountIn() {
      const enabled = !this.data.countInEnabled
      this.setData({ countInEnabled: enabled })
      if (!enabled && this.data.countInActive) {
        if (countInTimer) clearInterval(countInTimer)
        countInTimer = null
        this.beginMetronome()
      }
      wx.showToast({ title: enabled ? '已开启预备拍' : '已关闭预备拍', icon: 'none' })
    },
    continueLesson() { this.stopMetronome(); wx.navigateTo({ url: '../theory/index' }) },
    showComingSoon() { wx.showToast({ title: '这个练习正在准备中', icon: 'none' }) },
    showSetting(e: any) {
      const key = e.currentTarget.dataset.key
      if (key === 'feedback') {
        const next = this.data.feedbackMode === '温和' ? '直接' : this.data.feedbackMode === '直接' ? '少提示' : '温和'
        wx.setStorageSync('leta-feedback-mode', next)
        this.setData({ feedbackMode: next })
        wx.showToast({ title: `反馈：${next}`, icon: 'none' })
        return
      }
      if (key === 'audio') {
        wx.openSetting({ fail: (error) => { console.error('打开音频权限设置失败', error); wx.showToast({ title: '请在系统设置中检查麦克风权限', icon: 'none' }) } })
        return
      }
      wx.showModal({ title: '关于乐搭', content: '乐搭是陪音乐新手慢慢练基本功的小搭子。当前版本 0.1。\n\n导航图标来自 Flaticon，完整署名见项目素材说明。', showCancel: false, confirmText: '知道了' })
    },
  },
})
