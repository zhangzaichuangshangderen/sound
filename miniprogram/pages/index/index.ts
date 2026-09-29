type TabKey = 'sing' | 'instrument' | 'theory' | 'practice' | 'me'

let metronomeTimer: ReturnType<typeof setInterval> | null = null
let metronomeContext: any = null

Component({
  data: {
    activeTab: 'sing' as TabKey,
    tabs: [
      { key: 'sing', label: '唱' },
      { key: 'instrument', label: '乐器' },
      { key: 'theory', label: '乐理' },
      { key: 'practice', label: '练习' },
      { key: 'me', label: '我的' },
    ],
    theoryProgress: 2,
    metronomePlaying: false,
    bpm: 80,
    beat: 0,
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
    loadStats() { const stats = wx.getStorageSync('leta-stats') || {}; this.setData({ practiceMinutes: stats.practiceMinutes || 0, practiceDays: stats.practiceDays || 0, theoryProgress: stats.theoryProgress || 2 }) },
    switchTab(e: any) { const key = e.currentTarget.dataset.key as TabKey; if (key !== 'instrument') this.stopMetronome(); this.setData({ activeTab: key }) },
    startSinging() { this.stopMetronome(); wx.navigateTo({ url: '../singing/index?mode=scale' }) },
    startSingle() { this.stopMetronome(); wx.navigateTo({ url: '../singing/index?mode=single' }) },
    openMetronome() { this.setData({ activeTab: 'instrument' }) },
    openTheory() { this.setData({ activeTab: 'theory' }) },
    toggleMetronome() { this.data.metronomePlaying ? this.stopMetronome() : this.startMetronome() },
    startMetronome() { this.stopMetronome(); if (metronomeContext && metronomeContext.resume) { const resumeResult = metronomeContext.resume(); if (resumeResult && typeof resumeResult.catch === 'function') resumeResult.catch((error: any) => console.error('节拍器音频启动失败', error)) }; this.setData({ metronomePlaying: true, beat: 0 }); this.tickMetronome(); metronomeTimer = setInterval(() => this.tickMetronome(), 60000 / this.data.bpm) },
    stopMetronome() { if (metronomeTimer) clearInterval(metronomeTimer); metronomeTimer = null; this.setData({ metronomePlaying: false, beat: 0 }) },
    tickMetronome() { const beat = this.data.beat % 4 + 1; this.setData({ beat }); if (beat === 1) wx.vibrateShort({ type: 'light' }); this.playMetronomeTone(beat === 1) },
    playMetronomeTone(accent: boolean) { if (!metronomeContext) return; try { const now = metronomeContext.currentTime; const oscillator = metronomeContext.createOscillator(); const gain = metronomeContext.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = accent ? 1120 : 760; gain.gain.setValueAtTime(accent ? 0.24 : 0.13, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055); oscillator.connect(gain); gain.connect(metronomeContext.destination); oscillator.start(now); oscillator.stop(now + 0.06) } catch (error) { console.error('节拍器发声失败', error); this.stopMetronome(); wx.showToast({ title: '节拍器声音启动失败', icon: 'none' }) } },
    changeBpm(e: any) { const bpm = Math.max(40, Math.min(240, this.data.bpm + Number(e.currentTarget.dataset.delta))); this.setData({ bpm }); if (this.data.metronomePlaying) this.startMetronome() },
    continueLesson() { this.stopMetronome(); wx.navigateTo({ url: '../theory/index' }) },
    showComingSoon() { wx.showToast({ title: '这个练习正在准备中', icon: 'none' }) },
    showSetting(e: any) { const key = e.currentTarget.dataset.key; if (key === 'feedback') { const next = this.data.feedbackMode === '温和' ? '直接' : this.data.feedbackMode === '直接' ? '少提示' : '温和'; this.setData({ feedbackMode: next }); wx.showToast({ title: `反馈：${next}`, icon: 'none' }); return } wx.showToast({ title: key === 'audio' ? '示范音与录音设置' : '乐搭 v0.1', icon: 'none' }) },
  },
})
