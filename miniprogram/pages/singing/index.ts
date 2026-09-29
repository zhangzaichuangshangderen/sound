const RECORD_SAMPLE_RATE = 16000
const MAJOR_SCALE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12]

type ChartLine = { label: string; top: number; major: boolean }
type PitchSegment = { key: number; left: number; top: number; width: number; angle: number }
type PitchDot = { left: number; top: number }

Page({
  data: {
    started: false, finished: false, paused: false, recording: false, demoPlaying: false, starting: false,
    initialNote: 'C3', currentNote: '--', targetNote: 'C3', selectedOctave: 3, feedback: '先听模拟钢琴音，再开始唱',
    feedbackType: 'idle', pitch: '--', cents: 0, progress: 0, seconds: 0,
    frameCount: 0,
    octaveOptions: [1, 2, 3, 4, 5, 6],
    noteOptions: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    mode: 'scale',
    modeTitle: '音阶跟练',
    modeSubtitle: '先听一个音，再唱给乐搭听。',
    pitchHistory: [] as number[],
    chartLines: [] as ChartLine[],
    pitchSegments: [] as PitchSegment[],
    pitchDots: [] as PitchDot[],
    waveformBars: [] as number[],
    chartHasSignal: false,
    inputLevel: 0,
  },
  recorder: null as any,
  audioContext: null as any,
  demoSources: [] as any[],
  demoTimer: 0 as any,
  recordingWatchdog: 0 as any,
  elapsedTimer: 0 as any,
  captureMode: 'pcm' as 'pcm' | 'wav',
  activeRecorderMode: 'pcm' as 'pcm' | 'wav',
  recordingRequested: false,
  recorderActive: false,
  recorderStarting: false,
  detectedFrameCount: 0,
  detectedFrameCountAtRecorderStart: 0,
  chartMinMidi: 36,
  chartMaxMidi: 72,
  onLoad(options: any) {
    const single = options && options.mode === 'single'
    this.setData({ mode: single ? 'single' : 'scale', modeTitle: single ? '单音模唱' : '音阶跟练', modeSubtitle: single ? '听清目标音，唱准这一个音。' : '先听一个音，再唱给乐搭听。' })
    this.recorder = wx.getRecorderManager()
    wx.setInnerAudioOption({
      obeyMuteSwitch: false,
      speakerOn: true,
      mixWithOther: false,
      fail: (error) => {
        if (error.errMsg.includes('开发者工具暂时不支持')) {
          console.info('开发者工具跳过音频输出设置，真机仍会应用该配置')
          return
        }
        console.error('设置音频输出失败', error)
      },
    })
    this.recorder.onStart(() => {
      this.recorderStarting = false
      if (!this.recordingRequested || this.data.paused) {
        try { this.recorder.stop() } catch (error) { console.error('停止过期录音失败', error) }
        return
      }
      this.recorderActive = true
      this.startElapsedTimer()
      this.setData({ recording: true, feedback: '正在监听，请唱出当前音符', feedbackType: 'listening' })
    })
    this.recorder.onStop((result: any) => this.handleRecorderStop(result))
    this.recorder.onError((error: any) => {
      this.recorderActive = false
      this.recorderStarting = false
      console.error('录音失败', error)
      if (this.activeRecorderMode === 'pcm' && this.recordingRequested) {
        this.captureMode = 'wav'
        this.setData({ feedback: '正在切换兼容录音模式…', feedbackType: 'listening' })
        setTimeout(() => this.startRecorder(), 80)
        return
      }
      this.recordingRequested = false
      this.stopElapsedTimer()
      this.setData({ recording: false, feedback: '没有检测到录音，请检查麦克风权限', feedbackType: 'error' })
    })
    this.recorder.onFrameRecorded((res: any) => this.handleAudioFrame(res.frameBuffer))
  },
  onUnload() {
    this.recordingRequested = false
    this.stopRecorder()
    this.stopElapsedTimer()
    this.stopDemo()
    if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
  },
  onHide() {
    this.stopDemo()
    if (this.data.demoPlaying) this.setData({ demoPlaying: false })
    if (!this.data.started || !this.recordingRequested) return
    this.recordingRequested = false
    this.stopRecorder()
    this.stopElapsedTimer()
    this.setData({ paused: true, recording: false, feedback: '练习已暂停，回到页面后可继续', feedbackType: 'idle' })
  },
  chooseOctave(e: any) { const octave = Number(e.currentTarget.dataset.octave); const note = `${this.data.initialNote.slice(0, 1)}${octave}`; this.setData({ selectedOctave: octave, initialNote: note, currentNote: note }) },
  chooseInitial(e: any) { const note = `${e.currentTarget.dataset.note}${this.data.selectedOctave}`; this.setData({ initialNote: note, currentNote: note }); },
  toggleDemo() {
    if (this.data.demoPlaying) {
      this.stopDemo()
      this.setData({ demoPlaying: false, feedback: '已停止示范音', feedbackType: 'idle' })
      return
    }
    this.playDemo()
  },
  playDemo() {
    this.stopDemo()
    const wxAudio = wx as any
    if (typeof wxAudio.createWebAudioContext !== 'function') { this.setData({ demoPlaying: false, feedback: '当前微信版本不支持合成示范音', feedbackType: 'error' }); return }
    try {
      const ctx = wxAudio.createWebAudioContext()
      this.audioContext = ctx
      if (ctx.resume) {
        const resumeResult = ctx.resume()
        if (resumeResult && typeof resumeResult.catch === 'function') resumeResult.catch((error: any) => console.error('恢复音频上下文失败', error))
      }
      const now = ctx.currentTime
      const rootMidi = this.noteToMidi(this.data.initialNote)
      const scaleOffsets = this.data.mode === 'scale' ? MAJOR_SCALE_OFFSETS : [0]
      const beatSeconds = this.data.mode === 'scale' ? 1 : 0
      const noteDuration = this.data.mode === 'scale' ? 0.82 : 1.2
      this.demoSources = []
      scaleOffsets.forEach((offset: number, noteIndex: number) => {
        const frequency = 440 * Math.pow(2, (rootMidi + offset - 69) / 12)
        const harmonics = frequency < 130
          ? [[1, 0.24], [2, 0.42], [3, 0.22], [4, 0.10]]
          : [[1, 0.55], [2, 0.20], [3, 0.09], [4, 0.04]]
        const startTime = now + noteIndex * beatSeconds
        harmonics.forEach((item: number[]) => {
          const oscillator = ctx.createOscillator()
          const gain = ctx.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.value = frequency * item[0]
          gain.gain.setValueAtTime(0.0001, startTime)
          gain.gain.exponentialRampToValueAtTime(item[1], startTime + 0.012)
          gain.gain.exponentialRampToValueAtTime(0.0001, startTime + noteDuration)
          oscillator.connect(gain)
          gain.connect(ctx.destination)
          oscillator.start(startTime)
          oscillator.stop(startTime + noteDuration + 0.02)
          this.demoSources.push(oscillator)
        })
      })
      const totalDuration = (scaleOffsets.length - 1) * beatSeconds + noteDuration
      const description = this.data.mode === 'scale' ? `${this.data.initialNote} 大调音阶` : this.data.initialNote
      this.setData({ demoPlaying: true, feedback: `模拟钢琴音：${description}`, feedbackType: 'demo' })
      this.demoTimer = setTimeout(() => {
        this.demoSources = []
        const finishedContext = this.audioContext
        this.audioContext = null
        if (finishedContext && finishedContext.close) {
          const closeResult = finishedContext.close()
          if (closeResult && typeof closeResult.catch === 'function') closeResult.catch((error: any) => console.error('关闭音频上下文失败', error))
        }
        this.setData({ demoPlaying: false, feedback: '听清楚后，点击开始录音', feedbackType: 'idle' })
      }, Math.ceil(totalDuration * 1000) + 100) as any
    } catch (error) {
      console.error('合成示范音失败', error)
      this.setData({ demoPlaying: false, feedback: '示范音播放失败，请升级微信后重试', feedbackType: 'error' })
    }
  },
  stopDemo() {
    if (this.demoTimer) clearTimeout(this.demoTimer)
    this.demoTimer = 0
    this.demoSources.forEach((source: any) => {
      try { source.stop() } catch (error) { console.info('示范音节点已经结束', error) }
    })
    this.demoSources = []
    const context = this.audioContext
    this.audioContext = null
    if (context && context.close) {
      const closeResult = context.close()
      if (closeResult && typeof closeResult.catch === 'function') closeResult.catch((error: any) => console.error('关闭音频上下文失败', error))
    }
  },
  start() {
    if (this.data.starting || this.data.started) return
    this.stopDemo()
    this.setData({ starting: true, demoPlaying: false, feedback: '正在准备麦克风…', feedbackType: 'listening' })
    wx.getSetting({
      success: (settings) => {
        const permission = settings.authSetting['scope.record']
        if (permission === true) {
          this.beginPractice()
          return
        }
        if (permission === false) {
          this.handleRecordPermissionDenied()
          return
        }
        this.requestRecordPermission()
      },
      fail: (error) => {
        console.error('读取麦克风权限失败', error)
        this.requestRecordPermission()
      },
    })
  },
  requestRecordPermission() {
    wx.authorize({
      scope: 'scope.record',
      success: () => this.beginPractice(),
      fail: () => this.handleRecordPermissionDenied(),
    })
  },
  handleRecordPermissionDenied() {
    this.recordingRequested = false
    this.setData({ starting: false, recording: false, feedback: '需要麦克风权限才能检测音高', feedbackType: 'error' })
    wx.showModal({
      title: '需要麦克风权限',
      content: '允许使用麦克风后，乐搭才能听见你的音高。',
      confirmText: '去设置',
      success: (result) => {
        if (!result.confirm) return
        wx.openSetting({
          success: (settings) => {
            if (settings.authSetting['scope.record']) this.beginPractice()
          },
          fail: (error) => console.error('打开麦克风设置失败', error),
        })
      },
    })
  },
  beginPractice() {
    if (this.data.started && this.recordingRequested) return
    this.captureMode = 'pcm'
    this.recordingRequested = true
    this.detectedFrameCount = 0
    const chartLines = this.buildChartLines()
    this.setData({ starting: false, started: true, finished: false, paused: false, recording: false, feedback: '正在启动麦克风…', feedbackType: 'listening', progress: 0, seconds: 0, frameCount: 0, pitchHistory: [], pitchSegments: [], pitchDots: [], waveformBars: [], chartHasSignal: false, inputLevel: 0, currentNote: '--', targetNote: this.data.initialNote, pitch: '--', cents: 0, chartLines })
    this.startRecorder()
  },
  startRecorder() {
    if (!this.recordingRequested || this.recorderActive || this.recorderStarting) return
    this.activeRecorderMode = this.captureMode
    this.detectedFrameCountAtRecorderStart = this.detectedFrameCount
    this.recorderStarting = true
    try {
      if (this.activeRecorderMode === 'pcm') {
        this.recorder.start({ duration: 600000, sampleRate: RECORD_SAMPLE_RATE, numberOfChannels: 1, format: 'PCM', frameSize: 4 })
      } else {
        this.recorder.start({ duration: 1000, sampleRate: RECORD_SAMPLE_RATE, numberOfChannels: 1, format: 'wav' })
      }
      if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
      if (this.activeRecorderMode === 'pcm') {
        this.recordingWatchdog = setTimeout(() => {
          if (!this.recordingRequested || this.detectedFrameCount > this.detectedFrameCountAtRecorderStart) return
          this.captureMode = 'wav'
          this.setData({ feedback: '声音已收到，正在切换兼容音高分析…', feedbackType: 'listening' })
          if (this.recorderActive || this.recorderStarting) this.stopRecorder()
          setTimeout(() => this.startRecorder(), 100)
        }, 2500) as any
      }
    } catch (error) {
      this.recorderActive = false
      this.recorderStarting = false
      console.error('启动录音失败', error)
      if (this.activeRecorderMode === 'pcm' && this.recordingRequested) {
        this.captureMode = 'wav'
        this.setData({ feedback: '正在切换兼容录音模式…', feedbackType: 'listening' })
        setTimeout(() => this.startRecorder(), 80)
      } else {
        this.recordingRequested = false
        this.stopElapsedTimer()
        this.setData({ recording: false, feedback: '录音启动失败，请重试', feedbackType: 'error' })
      }
    }
  },
  stopRecorder() {
    if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
    this.recordingWatchdog = 0
    const shouldStop = this.recorderActive || this.recorderStarting
    this.recorderStarting = false
    if (shouldStop) {
      try { this.recorder.stop() } catch (error) { console.error('停止录音失败', error) }
    }
  },
  handleRecorderStop(result: any) {
    const completedMode = this.activeRecorderMode
    this.recorderActive = false
    this.recorderStarting = false
    if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
    this.recordingWatchdog = 0
    if (this.recordingRequested && completedMode === 'wav' && result && result.tempFilePath) this.processWavFile(result.tempFilePath)
    if (this.recordingRequested) {
      setTimeout(() => this.startRecorder(), 60)
    } else {
      this.stopElapsedTimer()
      this.setData({ recording: false })
    }
  },
  startElapsedTimer() {
    if (this.elapsedTimer) return
    this.elapsedTimer = setInterval(() => {
      if (!this.recordingRequested || this.data.paused) return
      const seconds = this.data.seconds + 1
      this.setData({ seconds, progress: Math.min(100, Math.round(seconds / 60 * 100)) })
    }, 1000) as any
  },
  stopElapsedTimer() {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer)
    this.elapsedTimer = 0
  },
  handleAudioFrame(buffer: ArrayBuffer) {
    if (!buffer || this.activeRecorderMode !== 'pcm' || this.data.paused || !this.recordingRequested) return
    const samples = this.toInt16Samples(buffer)
    if (!samples || samples.length < 1) return
    this.analyzeSamples(samples, RECORD_SAMPLE_RATE)
  },
  processWavFile(filePath: string) {
    try {
      const content = wx.getFileSystemManager().readFileSync(filePath)
      if (!(content instanceof ArrayBuffer)) throw new Error('录音文件不是二进制数据')
      const parsed = this.parseWav(content)
      if (!parsed) throw new Error('无法读取 WAV 录音数据')
      this.analyzeSamples(parsed.samples, parsed.sampleRate)
    } catch (error) {
      console.error('分析录音片段失败', error)
      this.setData({ feedback: '录音已收到，但音高分析失败，请重试', feedbackType: 'error' })
    }
  },
  parseWav(buffer: ArrayBuffer): { samples: Int16Array; sampleRate: number } | null {
    if (buffer.byteLength < 44) return null
    const view = new DataView(buffer)
    const chunkName = (offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
    if (chunkName(0) !== 'RIFF' || chunkName(8) !== 'WAVE') return null
    const sampleRate = view.getUint32(24, true) || RECORD_SAMPLE_RATE
    let offset = 12
    while (offset + 8 <= buffer.byteLength) {
      const name = chunkName(offset)
      const size = view.getUint32(offset + 4, true)
      const dataStart = offset + 8
      if (name === 'data') {
        const available = Math.min(size, buffer.byteLength - dataStart)
        const byteLength = available - (available % 2)
        if (byteLength < 2) return null
        const bytes = new Uint8Array(byteLength)
        bytes.set(new Uint8Array(buffer, dataStart, byteLength))
        return { samples: new Int16Array(bytes.buffer), sampleRate }
      }
      offset = dataStart + size + (size % 2)
    }
    return null
  },
  analyzeSamples(samples: Int16Array, sampleRate: number) {
    let sum = 0
    for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / Math.max(1, Math.ceil(samples.length / 4))) / 32768
    const inputLevel = Math.min(100, Math.round(rms * 900))
    const waveformBars = this.buildWaveformBars(samples)
    const detected = this.detectPitch(samples, sampleRate)
    if (detected) {
      this.detectedFrameCount++
      if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
      this.recordingWatchdog = 0
      const targetMidi = this.closestTargetMidi(detected)
      const target = 440 * Math.pow(2, (targetMidi - 69) / 12)
      const cents = Math.round(1200 * Math.log(detected / target) / Math.log(2))
      const history = this.data.pitchHistory.slice(-119).concat([detected])
      const visual = this.buildPitchVisual(history)
      this.setData({ frameCount: this.data.frameCount + 1, inputLevel, waveformBars, pitchHistory: history, pitchSegments: visual.segments, pitchDots: visual.dots, chartHasSignal: true, currentNote: this.hzToNote(detected), targetNote: this.midiToNote(targetMidi), pitch: `${detected.toFixed(1)} Hz`, cents, feedback: Math.abs(cents) <= 20 ? '音准稳定，保持住' : cents < 0 ? `偏低 ${Math.abs(cents)} cents，再高一点` : `偏高 ${cents} cents，再低一点`, feedbackType: Math.abs(cents) <= 20 ? 'good' : 'off' })
    } else this.setData({ frameCount: this.data.frameCount + 1, inputLevel, waveformBars, feedback: rms > 0.008 ? '声音进来了，正在定位音高' : '请靠近麦克风唱出持续音', feedbackType: rms > 0.008 ? 'listening' : 'idle' })
  },
  toInt16Samples(frame: any): Int16Array | null {
    try {
      const source = ArrayBuffer.isView(frame) ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : new Uint8Array(frame)
      let start = source.length >= 44 && source[0] === 82 && source[1] === 73 && source[2] === 70 && source[3] === 70 ? 44 : 0
      if (source.length - start < 2) start = 0
      const usableLength = source.byteLength - start
      const byteLength = usableLength - (usableLength % 2)
      if (byteLength < 2) return null
      const aligned = new Uint8Array(byteLength)
      aligned.set(source.subarray(start, start + byteLength))
      const littleEndian = new Int16Array(aligned.buffer)
      const bigEndian = new Int16Array(byteLength / 2)
      const view = new DataView(aligned.buffer)
      for (let index = 0; index < bigEndian.length; index++) bigEndian[index] = view.getInt16(index * 2, false)
      return this.pcmContinuityScore(bigEndian) < this.pcmContinuityScore(littleEndian) ? bigEndian : littleEndian
    } catch (error) {
      console.error('解析 PCM 录音帧失败', error)
      return null
    }
  },
  pcmContinuityScore(samples: Int16Array) {
    let movement = 0
    let energy = 0
    for (let index = 1; index < samples.length; index += 2) {
      movement += Math.abs(samples[index] - samples[index - 1])
      energy += Math.abs(samples[index])
    }
    return movement / Math.max(1, energy)
  },
  buildWaveformBars(samples: Int16Array) {
    const barCount = 36
    const levels: number[] = []
    let peak = 1
    for (let bar = 0; bar < barCount; bar++) {
      const center = Math.floor(bar * (samples.length - 1) / Math.max(1, barCount - 1))
      const start = Math.max(0, center - 2)
      const end = Math.min(samples.length, center + 3)
      let sum = 0
      for (let index = start; index < end; index++) sum += Math.abs(samples[index])
      const level = sum / Math.max(1, end - start)
      levels.push(level)
      peak = Math.max(peak, level)
    }
    return levels.map((level) => Math.max(8, Math.round(level / peak * 100)))
  },
  buildChartLines(): ChartLine[] {
    const rootMidi = this.noteToMidi(this.data.initialNote)
    this.chartMinMidi = rootMidi - 12
    this.chartMaxMidi = rootMidi + 24
    const naturalPitchClasses = [0, 2, 4, 5, 7, 9, 11]
    const lines: ChartLine[] = []
    for (let midi = this.chartMinMidi; midi <= this.chartMaxMidi; midi++) {
      const pitchClass = ((midi % 12) + 12) % 12
      if (!naturalPitchClasses.includes(pitchClass)) continue
      lines.push({ label: this.midiToNote(midi), top: this.midiToChartTop(midi), major: pitchClass === 0 })
    }
    return lines
  },
  buildPitchVisual(history: number[]): { segments: PitchSegment[]; dots: PitchDot[] } {
    const visible = history.slice(-80)
    const points = visible.map((hz: number, index: number) => {
      const midi = 69 + 12 * Math.log(hz / 440) / Math.log(2)
      return { left: 10 + index * (88 / Math.max(1, visible.length - 1)), top: this.midiToChartTop(midi) }
    })
    const segments: PitchSegment[] = []
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]
      const current = points[index]
      const dx = (current.left - previous.left) * 3.35
      const dy = (current.top - previous.top) * 2.85
      segments.push({ key: index, left: previous.left, top: previous.top, width: Math.sqrt(dx * dx + dy * dy) / 3.35, angle: Math.atan2(dy, dx) * 180 / Math.PI })
    }
    return { segments, dots: points.length ? [points[points.length - 1]] : [] }
  },
  midiToChartTop(midi: number) {
    const bounded = Math.max(this.chartMinMidi, Math.min(this.chartMaxMidi, midi))
    return 4 + (this.chartMaxMidi - bounded) / (this.chartMaxMidi - this.chartMinMidi) * 92
  },
  closestTargetMidi(hz: number) {
    const sungMidi = 69 + 12 * Math.log(hz / 440) / Math.log(2)
    const rootMidi = this.noteToMidi(this.data.initialNote)
    const targets = this.data.mode === 'scale' ? MAJOR_SCALE_OFFSETS.map((offset) => rootMidi + offset) : [rootMidi]
    return targets.reduce((closest, candidate) => Math.abs(candidate - sungMidi) < Math.abs(closest - sungMidi) ? candidate : closest, targets[0])
  },
  detectPitch(samples: Int16Array, sampleRate = RECORD_SAMPLE_RATE) {
    const minLag = Math.max(2, Math.floor(sampleRate / 1100))
    const maxLag = Math.min(Math.floor(sampleRate / 32), Math.floor(samples.length / 2))
    if (maxLag <= minLag) return 0
    const sampleStep = samples.length > 4096 ? Math.ceil(samples.length / 4096) : 1
    const difference = new Float64Array(maxLag + 1)
    const normalized = new Float64Array(maxLag + 1)
    let runningSum = 0
    normalized[0] = 1
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0
      let count = 0
      for (let index = 0; index + lag < samples.length; index += sampleStep) {
        const delta = samples[index] - samples[index + lag]
        sum += delta * delta
        count++
      }
      difference[lag] = count ? sum / count : 0
      runningSum += difference[lag]
      normalized[lag] = runningSum > 0 ? difference[lag] * lag / runningSum : 1
    }
    let selectedLag = 0
    for (let lag = minLag; lag < maxLag; lag++) {
      if (normalized[lag] >= 0.25) continue
      while (lag + 1 <= maxLag && normalized[lag + 1] < normalized[lag]) lag++
      selectedLag = lag
      break
    }
    if (!selectedLag) {
      let bestValue = 1
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (normalized[lag] < bestValue) { bestValue = normalized[lag]; selectedLag = lag }
      }
      if (bestValue > 0.42) return 0
    }
    const left = normalized[Math.max(minLag, selectedLag - 1)]
    const center = normalized[selectedLag]
    const right = normalized[Math.min(maxLag, selectedLag + 1)]
    const denominator = left - 2 * center + right
    const refinedLag = denominator === 0 ? selectedLag : selectedLag + 0.5 * (left - right) / denominator
    return refinedLag > 0 ? sampleRate / refinedLag : 0
  },
  noteToHz(note: string) { const match = /^([A-G])([1-6])$/.exec(note); if (!match) return 261.63; const semitones: any = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }; const midi = (Number(match[2]) + 1) * 12 + semitones[match[1]]; return 440 * Math.pow(2, (midi - 69) / 12) },
  noteToMidi(note: string) { const match = /^([A-G])([1-6])$/.exec(note); if (!match) return 48; const semitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }; return (Number(match[2]) + 1) * 12 + semitones[match[1]] },
  midiToNote(midi: number) { const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']; const rounded = Math.round(midi); return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}` },
  hzToNote(hz: number) { return this.midiToNote(69 + 12 * Math.log(hz / 440) / Math.log(2)) },
  finish() { this.recordingRequested = false; this.stopRecorder(); this.stopElapsedTimer(); const old = wx.getStorageSync('leta-stats') || {}; const today = new Date().toDateString(); this.setData({ finished: true, started: false, recording: false, feedback: '练习结束，做得很好' }); wx.setStorageSync('leta-stats', { ...old, practiceMinutes: (old.practiceMinutes || 0) + Math.max(1, Math.round(this.data.seconds / 60)), practiceDays: old.lastPracticeDay === today ? (old.practiceDays || 0) : (old.practiceDays || 0) + 1, lastPracticeDay: today }) },
  pause() { if (this.data.paused) { this.recordingRequested = true; this.setData({ paused: false, feedback: '正在监听，请唱出当前音符' }); this.startRecorder(); return } this.recordingRequested = false; this.stopRecorder(); this.stopElapsedTimer(); this.setData({ paused: true, recording: false, feedback: '先休息一下，准备好再继续', feedbackType: 'idle' }) },
  goBack() { this.recordingRequested = false; this.stopRecorder(); wx.navigateBack() },
  goHome() { wx.navigateBack() },
  restart() { this.setData({ finished: false, progress: 0, seconds: 0 }); this.start() },
})
