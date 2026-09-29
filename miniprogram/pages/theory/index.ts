const THEORY_AUDIO_FILE = `${wx.env.USER_DATA_PATH}/leta-theory-semitone-v3.wav`

let theoryAudio: WechatMiniprogram.InnerAudioContext | null = null
let theoryAudioReady = false
let theoryPageActive = false

Page({
  data: {
    playing: false,
    completed: false,
    answer: '',
    answered: false,
  },

  onLoad() {
    theoryPageActive = true
    this.prepareTheoryAudio()
  },

  onUnload() {
    theoryPageActive = false
    this.destroyTheoryAudio()
  },

  onHide() {
    if (theoryAudio) theoryAudio.stop()
  },

  prepareTheoryAudio() {
    theoryAudioReady = false
    this.destroyTheoryAudio()

    try {
      const wavData = this.createSemitoneWav()
      wx.getFileSystemManager().writeFileSync(THEORY_AUDIO_FILE, wavData)

      theoryAudio = wx.createInnerAudioContext()
      theoryAudio.autoplay = false
      theoryAudio.volume = 1
      theoryAudio.obeyMuteSwitch = false
      theoryAudio.src = THEORY_AUDIO_FILE
      theoryAudio.onPlay(() => {
        if (theoryPageActive) this.setData({ playing: true })
      })
      theoryAudio.onEnded(() => {
        if (theoryPageActive) this.setData({ playing: false })
      })
      theoryAudio.onStop(() => {
        if (theoryPageActive) this.setData({ playing: false })
      })
      theoryAudio.onError((error) => {
        console.error('乐理示范音播放失败', error)
        if (!theoryPageActive) return
        this.setData({ playing: false })
        wx.showToast({ title: '示范音播放失败，请重试', icon: 'none' })
      })
      theoryAudioReady = true

      wx.setInnerAudioOption({
        obeyMuteSwitch: false,
        speakerOn: true,
        mixWithOther: false,
        fail: (error) => {
          const message = error && error.errMsg ? error.errMsg : ''
          if (message.includes('开发者工具暂时不支持')) {
            console.info('开发者工具跳过音频输出设置，真机仍会应用该配置')
            return
          }
          console.error('设置乐理音频输出失败', error)
        },
      })
    } catch (error) {
      console.error('准备乐理示范音失败', error)
      theoryAudioReady = false
    }
  },

  togglePlay() {
    if (!theoryAudioReady || !theoryAudio) {
      this.prepareTheoryAudio()
      if (!theoryAudioReady || !theoryAudio) {
        wx.showToast({ title: '示范音准备失败，请重试', icon: 'none' })
        return
      }
    }

    if (this.data.playing) {
      theoryAudio.stop()
      return
    }

    try {
      theoryAudio.stop()
      theoryAudio.src = THEORY_AUDIO_FILE
      theoryAudio.play()
    } catch (error) {
      console.error('启动乐理示范音失败', error)
      this.setData({ playing: false })
      wx.showToast({ title: '示范音播放失败，请重试', icon: 'none' })
    }
  },

  createSemitoneWav() {
    const sampleRate = 44100
    const durationSeconds = 1.5
    const sampleCount = Math.floor(sampleRate * durationSeconds)
    const wavBuffer = new ArrayBuffer(44 + sampleCount * 2)
    const view = new DataView(wavBuffer)

    const writeText = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index))
      }
    }

    writeText(0, 'RIFF')
    view.setUint32(4, 36 + sampleCount * 2, true)
    writeText(8, 'WAVE')
    writeText(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeText(36, 'data')
    view.setUint32(40, sampleCount * 2, true)

    const notes = [
      { start: 0, end: 0.58, frequency: 261.6256 },
      { start: 0.78, end: 1.36, frequency: 277.1826 },
    ]

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const time = sampleIndex / sampleRate
      let sample = 0

      for (const note of notes) {
        if (time < note.start || time >= note.end) continue
        const localTime = time - note.start
        const noteDuration = note.end - note.start
        const attack = Math.min(1, localTime / 0.012)
        const release = Math.min(1, (noteDuration - localTime) / 0.08)
        const decay = Math.exp(-2.1 * localTime)
        const envelope = attack * release * (0.45 + 0.55 * decay)
        const phase = 2 * Math.PI * note.frequency * localTime
        sample = envelope * (
          Math.sin(phase) * 0.68
          + Math.sin(phase * 2) * 0.19
          + Math.sin(phase * 3) * 0.08
        )
        break
      }

      const pcmValue = Math.max(-32768, Math.min(32767, Math.round(sample * 19000)))
      view.setInt16(44 + sampleIndex * 2, pcmValue, true)
    }

    return wavBuffer
  },

  chooseAnswer(event: WechatMiniprogram.TouchEvent) {
    const answer = String(event.currentTarget.dataset.answer || '')
    this.setData({ answer, answered: answer === '半音' })
  },

  complete() {
    if (this.data.completed) {
      wx.navigateBack()
      return
    }
    if (!this.data.answered) {
      wx.showToast({ title: '先答对小练习再继续', icon: 'none' })
      return
    }

    const stats = wx.getStorageSync('leta-stats') || {}
    wx.setStorageSync('leta-stats', { ...stats, theoryProgress: Math.max(3, Number(stats.theoryProgress) || 0) })
    this.setData({ completed: true })
    wx.showToast({ title: '完成第 3 课', icon: 'success' })
  },

  goBack() {
    if (theoryAudio) theoryAudio.stop()
    wx.navigateBack()
  },

  destroyTheoryAudio() {
    if (!theoryAudio) return
    theoryAudio.stop()
    theoryAudio.destroy()
    theoryAudio = null
    theoryAudioReady = false
  },
})
