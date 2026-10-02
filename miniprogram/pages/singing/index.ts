import { createRecorderSession, createSequentialProgressTracker } from '../../utils/audio-session'
import { createPianoTone } from '../../utils/note-synth'

const RECORD_SAMPLE_RATE = 16000
const MAX_PLAYBACK_SECONDS = 180
const MAJOR_SCALE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12]
const CHART_VIEW_SECONDS = 8
const CHART_VIEW_WIDTH_RPX = 670
const CHART_HEIGHT_RPX = 560
// 音阶跟练按“检测到有效音高”推进，不要求必须唱准；保留短暂持续时间避免
// 麦克风噪声或单个误检直接跳过多个目标音。
const SCALE_TARGET_DETECT_MS = 500

type ChartLine = { label: string; top: number; major: boolean }
type TargetGuide = { label: string; top: number; stagger: boolean }
type PitchSegment = { key: number; left: number; top: number; width: number; angle: number }
type PitchDot = { left: number; top: number }
type RecordedPitchFrame = { at: number; frequency: number; level: number; targetMidi: number }

let recorderSession: ReturnType<typeof createRecorderSession> | null = null

Page({
  data: {
    started: false, finished: false, paused: false, recording: false, demoPlaying: false, recordingPlayback: false, starting: false,
    initialNote: 'C3', currentNote: '--', targetNote: 'C3', selectedOctave: 3, feedback: '先听模拟钢琴音，再开始唱',
    feedbackType: 'idle', pitch: '--', cents: 0, progress: 0, seconds: 0,
    frameCount: 0,
    voicedFrames: 0,
    inTuneFrames: 0,
    steadyPercent: 0,
    octaveOptions: [1, 2, 3, 4, 5, 6],
    noteOptions: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    mode: 'scale',
    modeTitle: '音阶跟练',
    modeSubtitle: '先听一个音，再唱给乐搭听。',
    scaleStep: 1,
    scaleStepTotal: MAJOR_SCALE_OFFSETS.length,
    scaleCompleted: false,
    pitchHistory: [] as number[],
    chartLines: [] as ChartLine[],
    targetGuides: [] as TargetGuide[],
    pitchSegments: [] as PitchSegment[],
    pitchDots: [] as PitchDot[],
    waveformBars: [] as number[],
    chartHasSignal: false,
    inputLevel: 0,
    hasRecording: false,
    playbackSeconds: 0,
    playbackDuration: 0,
    playbackProgress: 0,
    chartWidthRpx: CHART_VIEW_WIDTH_RPX,
    chartScrollLeft: 0,
    chartFollowLatest: true,
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
  activeCaptureId: 0,
  wavFailureCount: 0,
  resumeRecordingAfterDemo: false,
  pendingRecordingPlayback: false,
  pendingPracticeRestart: false,
  recordingPlayer: null as WechatMiniprogram.InnerAudioContext | null,
  recordedPcmChunks: [] as Int16Array[],
  recordedPitchFrames: [] as RecordedPitchFrame[],
  recordedSampleCount: 0,
  playbackLimitNotified: false,
  detectedFrameCount: 0,
  detectedFrameCountAtRecorderStart: 0,
  chartMinMidi: 36,
  chartMaxMidi: 72,
  chartTouchStartX: null as number | null,
  chartCurrentScrollLeft: 0,
  chartPinchStartDistance: null as number | null,
  chartPinchStartZoom: 1,
  chartZoom: 1,
  scaleProgress: createSequentialProgressTracker(MAJOR_SCALE_OFFSETS.length, SCALE_TARGET_DETECT_MS),
  feedbackMode: '温和' as '温和' | '直接' | '少提示',
  onLoad(options: any) {
    const single = options && options.mode === 'single'
    const modeTitle = single ? '单音模唱' : '音阶跟练'
    this.setData({ mode: single ? 'single' : 'scale', modeTitle, modeSubtitle: single ? '听清目标音，唱准这一个音。' : '先听一个音，再唱给乐搭听。' })
    wx.setNavigationBarTitle({ title: modeTitle })
    const storedFeedbackMode = wx.getStorageSync('leta-feedback-mode')
    if (storedFeedbackMode === '直接' || storedFeedbackMode === '少提示') this.feedbackMode = storedFeedbackMode
    if (!recorderSession) recorderSession = createRecorderSession(wx.getRecorderManager())
    this.recorder = recorderSession.attach(this)
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
  },
  onUnload() {
    this.resumeRecordingAfterDemo = false
    this.pendingRecordingPlayback = false
    this.pendingPracticeRestart = false
    this.destroyRecordingPlayer()
    this.recordingRequested = false
    this.stopRecorder()
    this.stopElapsedTimer()
    this.stopDemo()
    if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
    if (recorderSession) recorderSession.detach(this)
  },
  onHide() {
    const wasPracticeDemo = this.data.started && this.data.demoPlaying
    this.resumeRecordingAfterDemo = false
    this.pendingRecordingPlayback = false
    this.pendingPracticeRestart = false
    this.stopRecordingPlayback(false)
    this.stopDemo()
    if (this.data.demoPlaying) this.setData({ demoPlaying: false })
    if (!this.data.started || (!this.recordingRequested && !wasPracticeDemo)) return
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
  togglePracticeDemo() {
    if (this.data.recordingPlayback) this.stopRecordingPlayback(false)
    if (this.data.demoPlaying) {
      this.stopDemo()
      this.setData({ demoPlaying: false })
      this.resumeAfterPracticeDemo('已停止范音，继续唱吧')
      return
    }
    this.resumeRecordingAfterDemo = !this.data.paused && this.recordingRequested
    this.recordingRequested = false
    this.stopRecorder()
    this.stopElapsedTimer()
    const demoName = this.data.mode === 'scale' ? `${this.data.initialNote} 大调音阶` : `目标音 ${this.data.initialNote}`
    this.setData({ recording: false, feedback: `正在播放 ${demoName}`, feedbackType: 'demo' })
    this.playDemo()
  },
  resumeAfterPracticeDemo(message = '范音播放完毕，继续唱吧', feedbackType = 'listening') {
    const shouldResume = this.resumeRecordingAfterDemo && this.data.started && !this.data.paused && !this.data.finished
    this.resumeRecordingAfterDemo = false
    if (shouldResume) {
      this.recordingRequested = true
      this.setData({ feedback: message, feedbackType })
      this.startRecorder()
      return
    }
    if (this.data.started) this.setData({ feedback: feedbackType === 'error' ? message : '范音播放完毕，练习仍暂停', feedbackType: feedbackType === 'error' ? 'error' : 'idle' })
  },
  playDemo() {
    this.stopDemo()
    const practiceDemo = this.data.started
    const wxAudio = wx as any
    if (typeof wxAudio.createWebAudioContext !== 'function') {
      this.setData({ demoPlaying: false, feedback: '当前微信版本不支持合成示范音', feedbackType: 'error' })
      if (practiceDemo) this.resumeAfterPracticeDemo('范音播放失败，请升级微信后重试', 'error')
      return
    }
    try {
      const ctx = wxAudio.createWebAudioContext()
      this.audioContext = ctx
      if (ctx.resume) {
        const resumeResult = ctx.resume()
        if (resumeResult && typeof resumeResult.catch === 'function') {
          resumeResult.catch((error: any) => {
            if (this.audioContext !== ctx) return
            console.error('恢复音频上下文失败', error)
            this.stopDemo()
            this.setData({ demoPlaying: false, feedback: '范音播放失败，请重试', feedbackType: 'error' })
            if (practiceDemo) this.resumeAfterPracticeDemo('范音播放失败，请重试', 'error')
          })
        }
      }
      const now = ctx.currentTime
      const scaleDemo = this.data.mode === 'scale'
      const rootNote = scaleDemo ? this.data.initialNote : practiceDemo ? this.data.targetNote : this.data.initialNote
      const rootMidi = this.noteToMidi(rootNote)
      const scaleOffsets = scaleDemo ? MAJOR_SCALE_OFFSETS : [0]
      const beatSeconds = scaleDemo ? 1 : 0
      const noteDuration = scaleDemo ? 0.82 : 1.2
      this.demoSources = []
      scaleOffsets.forEach((offset: number, noteIndex: number) => {
        const frequency = 440 * Math.pow(2, (rootMidi + offset - 69) / 12)
        const startTime = now + noteIndex * beatSeconds
        this.demoSources.push(...createPianoTone(ctx, frequency, startTime, noteDuration))
      })
      const totalDuration = (scaleOffsets.length - 1) * beatSeconds + noteDuration
      const description = scaleDemo ? `${rootNote} 大调音阶` : `${rootNote} 范音`
      this.setData({ demoPlaying: true, feedback: `模拟钢琴音：${description}`, feedbackType: 'demo' })
      this.demoTimer = setTimeout(() => {
        this.demoSources = []
        const finishedContext = this.audioContext
        this.audioContext = null
        if (finishedContext && finishedContext.close) {
          const closeResult = finishedContext.close()
          if (closeResult && typeof closeResult.catch === 'function') closeResult.catch((error: any) => console.error('关闭音频上下文失败', error))
        }
        this.setData({ demoPlaying: false })
        if (practiceDemo) this.resumeAfterPracticeDemo()
        else this.setData({ feedback: '听清楚后，点击开始录音', feedbackType: 'idle' })
      }, Math.ceil(totalDuration * 1000) + 100) as any
    } catch (error) {
      console.error('合成示范音失败', error)
      this.setData({ demoPlaying: false, feedback: '示范音播放失败，请升级微信后重试', feedbackType: 'error' })
      if (practiceDemo) this.resumeAfterPracticeDemo('范音播放失败，请重试', 'error')
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
    this.stopRecordingPlayback(false)
    this.recordedPcmChunks = []
    this.recordedPitchFrames = []
    this.recordedSampleCount = 0
    this.playbackLimitNotified = false
    this.captureMode = 'pcm'
    this.recordingRequested = true
    this.wavFailureCount = 0
    this.detectedFrameCount = 0
    this.chartCurrentScrollLeft = 0
    this.scaleProgress.reset()
    const chartLines = this.buildChartLines()
    const targetGuides = this.buildTargetGuides()
    this.setData({ starting: false, started: true, finished: false, paused: false, recording: false, recordingPlayback: false, hasRecording: false, playbackSeconds: 0, playbackDuration: 0, playbackProgress: 0, feedback: '正在启动麦克风…', feedbackType: 'listening', progress: 0, seconds: 0, frameCount: 0, voicedFrames: 0, inTuneFrames: 0, steadyPercent: 0, pitchHistory: [], pitchSegments: [], pitchDots: [], waveformBars: [], chartHasSignal: false, inputLevel: 0, currentNote: '--', targetNote: this.data.initialNote, pitch: '--', cents: 0, scaleStep: 1, scaleCompleted: false, chartLines, targetGuides, chartWidthRpx: CHART_VIEW_WIDTH_RPX, chartScrollLeft: 0, chartFollowLatest: true })
    this.startRecorder()
  },
  handleRecorderStarted() {
    this.recorderStarting = false
    if (!this.recordingRequested || this.data.paused) {
      try { this.recorder.stop() } catch (error) { console.error('停止过期录音失败', error) }
      return
    }
    this.recorderActive = true
    this.startElapsedTimer()
    this.setData({ recording: true, feedback: '正在监听，请唱出当前音符', feedbackType: 'listening' })
  },
  handleRecorderError(error: any) {
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
  },
  startRecorder() {
    if (!this.recordingRequested || this.recorderActive || this.recorderStarting) return
    this.activeCaptureId++
    this.activeRecorderMode = this.captureMode
    this.detectedFrameCountAtRecorderStart = this.detectedFrameCount
    this.recorderStarting = true
    try {
      if (!recorderSession) throw new Error('录音管理器不可用')
      if (this.activeRecorderMode === 'pcm') {
        if (!recorderSession.start(this, { duration: 600000, sampleRate: RECORD_SAMPLE_RATE, numberOfChannels: 1, format: 'PCM', frameSize: 4 })) {
          this.recorderStarting = false
          this.setData({ recording: false, feedback: '上一段录音正在结束，请稍后重试', feedbackType: 'listening' })
          recorderSession.whenIdle(() => {
            if (this.recordingRequested && !this.data.paused) setTimeout(() => this.startRecorder(), 120)
          })
          return
        }
      } else {
        if (!recorderSession.start(this, { duration: 1000, sampleRate: RECORD_SAMPLE_RATE, numberOfChannels: 1, format: 'wav' })) {
          this.recorderStarting = false
          this.setData({ recording: false, feedback: '上一段录音正在结束，请稍后重试', feedbackType: 'listening' })
          recorderSession.whenIdle(() => {
            if (this.recordingRequested && !this.data.paused) setTimeout(() => this.startRecorder(), 120)
          })
          return
        }
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
    const completedCaptureId = this.activeCaptureId
    this.recorderActive = false
    this.recorderStarting = false
    if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
    this.recordingWatchdog = 0
    if (!this.recordingRequested) {
      this.stopElapsedTimer()
      this.setData({ recording: false })
      if (this.pendingPracticeRestart) {
        this.pendingPracticeRestart = false
        setTimeout(() => this.beginPractice(), 120)
        return
      }
      if (this.pendingRecordingPlayback) {
        this.pendingRecordingPlayback = false
        setTimeout(() => this.startRecordingPlayback(), 120)
      }
      return
    }
    if (completedMode === 'wav') {
      if (!result || !result.tempFilePath) {
        this.handleWavFailure(new Error('录音结束后未返回临时文件路径'), () => this.scheduleNextRecording())
        return
      }
      setTimeout(() => {
        if (!this.recordingRequested || completedCaptureId !== this.activeCaptureId) return
        this.processWavFile(result.tempFilePath, completedCaptureId, () => this.scheduleNextRecording())
      }, 80)
      return
    }
    this.scheduleNextRecording()
  },
  scheduleNextRecording() {
    if (!this.recordingRequested || this.data.paused) return
    setTimeout(() => {
      if (this.recordingRequested && !this.data.paused) this.startRecorder()
    }, 60)
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
    const recordedAt = this.captureRecordingSamples(samples, RECORD_SAMPLE_RATE)
    this.analyzeSamples(samples, RECORD_SAMPLE_RATE, recordedAt)
  },
  processWavFile(filePath: string, captureId: number, onComplete: () => void, attempt = 0) {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (result) => {
        if (!this.recordingRequested || captureId !== this.activeCaptureId) return
        if (!(result.data instanceof ArrayBuffer)) {
          this.handleWavFailure(new Error('录音文件不是二进制数据'), onComplete)
          return
        }
        const parsed = this.parseWav(result.data)
        if (!parsed) {
          this.handleWavFailure(new Error('无法读取 WAV 录音数据'), onComplete)
          return
        }
        this.wavFailureCount = 0
        const recordedAt = this.captureRecordingSamples(parsed.samples, parsed.sampleRate)
        this.analyzeSamples(parsed.samples, parsed.sampleRate, recordedAt)
        onComplete()
      },
      fail: (error) => {
        if (!this.recordingRequested || captureId !== this.activeCaptureId) return
        const pendingFile = /not found|no such file|not exist/i.test(error.errMsg || '')
        if (pendingFile && attempt < 2) {
          const retryDelay = attempt === 0 ? 120 : 240
          setTimeout(() => {
            if (!this.recordingRequested || captureId !== this.activeCaptureId) return
            this.processWavFile(filePath, captureId, onComplete, attempt + 1)
          }, retryDelay)
          return
        }
        this.handleWavFailure(new Error(error.errMsg || '读取录音临时文件失败'), onComplete)
      },
    })
  },
  handleWavFailure(error: Error, onComplete: () => void) {
    this.wavFailureCount++
    console.error('分析录音片段失败', { error, consecutiveFailures: this.wavFailureCount })
    if (this.wavFailureCount >= 3) {
      this.recordingRequested = false
      this.stopElapsedTimer()
      this.setData({ recording: false, feedback: '录音文件连续读取失败，请暂停后重新开始；若仍失败请更新微信', feedbackType: 'error' })
      return
    }
    this.setData({ feedback: '这一小段录音读取失败，正在重新监听…', feedbackType: 'listening' })
    onComplete()
  },
  captureRecordingSamples(samples: Int16Array, sampleRate: number): number | null {
    const normalized = sampleRate === RECORD_SAMPLE_RATE ? samples : this.resampleSamples(samples, sampleRate, RECORD_SAMPLE_RATE)
    const maxSamples = RECORD_SAMPLE_RATE * MAX_PLAYBACK_SECONDS
    const remaining = maxSamples - this.recordedSampleCount
    if (remaining <= 0) {
      if (!this.playbackLimitNotified) {
        this.playbackLimitNotified = true
        wx.showToast({ title: '回放最多保留前 3 分钟', icon: 'none' })
      }
      return null
    }
    const length = Math.min(remaining, normalized.length)
    if (length < 1) return null
    const copy = new Int16Array(length)
    copy.set(normalized.subarray(0, length))
    this.recordedPcmChunks.push(copy)
    this.recordedSampleCount += length
    if (!this.data.hasRecording) this.setData({ hasRecording: true })
    return this.recordedSampleCount / RECORD_SAMPLE_RATE * 1000
  },
  resampleSamples(samples: Int16Array, sourceRate: number, targetRate: number) {
    if (sourceRate <= 0 || sourceRate === targetRate) return samples
    const targetLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate))
    const output = new Int16Array(targetLength)
    for (let index = 0; index < targetLength; index++) {
      const sourceIndex = Math.min(samples.length - 1, Math.round(index * sourceRate / targetRate))
      output[index] = samples[sourceIndex]
    }
    return output
  },
  toggleRecordingPlayback() {
    if (this.data.recordingPlayback) {
      this.stopRecordingPlayback(true)
      return
    }
    if (!this.data.hasRecording || this.recordedSampleCount < 1) {
      wx.showToast({ title: '先唱几秒，再来回放', icon: 'none' })
      return
    }
    this.stopDemo()
    const waitForRecorder = this.recorderActive || this.recorderStarting
    this.pendingRecordingPlayback = waitForRecorder
    this.recordingRequested = false
    this.stopElapsedTimer()
    this.setData({ paused: true, recording: false, demoPlaying: false, feedback: '正在准备本次录音…', feedbackType: 'demo' })
    this.stopRecorder()
    if (!waitForRecorder) this.startRecordingPlayback()
  },
  startRecordingPlayback() {
    if (!this.data.hasRecording || this.recordedSampleCount < 1) return
    this.destroyRecordingPlayer()
    const wav = this.buildRecordingWav()
    const duration = this.recordedSampleCount / RECORD_SAMPLE_RATE
    const chartWidthRpx = this.chartWidthForDuration(duration * 1000)
    const filePath = `${wx.env.USER_DATA_PATH}/leta-practice-preview.wav`
    this.setData({ recordingPlayback: true, playbackSeconds: 0, playbackDuration: Math.ceil(duration), playbackProgress: 0, pitchHistory: [], pitchSegments: [], pitchDots: [], chartHasSignal: false, currentNote: '--', pitch: '--', cents: 0, feedback: '正在准备录音回放…', feedbackType: 'demo', chartWidthRpx, chartScrollLeft: 0, chartFollowLatest: true })
    wx.getFileSystemManager().writeFile({
      filePath,
      data: wav,
      success: () => {
        if (!this.data.recordingPlayback) return
        const player = wx.createInnerAudioContext()
        this.recordingPlayer = player
        player.autoplay = true
        player.obeyMuteSwitch = false
        player.onPlay(() => {
          if (this.recordingPlayer !== player) return
          this.setData({ feedback: '正在回放，你唱过的音高会依次出现', feedbackType: 'demo' })
        })
        player.onTimeUpdate(() => {
          if (this.recordingPlayer === player) this.updateRecordingPlayback(player.currentTime)
        })
        player.onEnded(() => {
          if (this.recordingPlayer !== player) return
          this.updateRecordingPlayback(duration)
          this.destroyRecordingPlayer()
          this.setData({ recordingPlayback: false, playbackSeconds: Math.ceil(duration), playbackProgress: 100, inputLevel: 0, feedback: '回放结束，可以继续录音', feedbackType: 'idle' })
        })
        player.onError((error) => {
          if (this.recordingPlayer !== player) return
          console.error('播放练习录音失败', error)
          this.destroyRecordingPlayer()
          this.setData({ recordingPlayback: false, inputLevel: 0, feedback: '录音回放失败，请重试', feedbackType: 'error' })
        })
        player.src = filePath
      },
      fail: (error) => {
        console.error('保存练习录音失败', error)
        this.setData({ recordingPlayback: false, inputLevel: 0, feedback: '录音准备失败，请重试', feedbackType: 'error' })
      },
    })
  },
  updateRecordingPlayback(currentTime: number) {
    const duration = Math.max(0.001, this.recordedSampleCount / RECORD_SAMPLE_RATE)
    const currentMs = Math.max(0, Math.min(duration, currentTime)) * 1000
    const playbackProgress = Math.min(100, currentMs / (duration * 1000) * 100)
    const visibleFrames = this.recordedPitchFrames.filter((frame) => frame.at <= currentMs)
    const chartWidthRpx = this.chartWidthForDuration(duration * 1000)
    const visual = this.buildRecordedPitchVisual(visibleFrames, duration * 1000, chartWidthRpx)
    const chartScrollLeft = this.data.chartFollowLatest ? this.chartScrollForPosition(chartWidthRpx, playbackProgress / 100) : this.data.chartScrollLeft
    const currentFrame = visibleFrames.length ? visibleFrames[visibleFrames.length - 1] : null
    let detectedFrame: RecordedPitchFrame | null = null
    for (let index = visibleFrames.length - 1; index >= 0; index--) {
      if (visibleFrames[index].frequency > 0) { detectedFrame = visibleFrames[index]; break }
    }
    const hasCurrentPitch = !!detectedFrame && currentMs - detectedFrame.at < 650
    if (!hasCurrentPitch || !detectedFrame) {
      this.setData({ playbackSeconds: Math.floor(currentMs / 1000), playbackProgress, inputLevel: currentFrame ? currentFrame.level : 0, pitchSegments: visual.segments, pitchDots: visual.dots, chartHasSignal: visual.segments.length > 0 || visual.dots.length > 0, currentNote: '--', pitch: '--', cents: 0, chartWidthRpx, chartScrollLeft })
      return
    }
    const targetMidi = detectedFrame.targetMidi
    const target = 440 * Math.pow(2, (targetMidi - 69) / 12)
    const cents = Math.round(1200 * Math.log(detectedFrame.frequency / target) / Math.log(2))
    this.setData({ playbackSeconds: Math.floor(currentMs / 1000), playbackProgress, inputLevel: currentFrame ? currentFrame.level : 0, pitchSegments: visual.segments, pitchDots: visual.dots, chartHasSignal: true, currentNote: this.hzToNote(detectedFrame.frequency), targetNote: this.midiToNote(targetMidi), pitch: `${detectedFrame.frequency.toFixed(1)} Hz`, cents, chartWidthRpx, chartScrollLeft })
  },
  buildRecordedPitchVisual(frames: RecordedPitchFrame[], durationMs: number, chartWidthRpx = CHART_VIEW_WIDTH_RPX): { segments: PitchSegment[]; dots: PitchDot[] } {
    const detected = frames.filter((frame) => frame.frequency > 0)
    // 按时间采样，避免不同真机的录音回调频率导致轨迹过密。
    const sampled: RecordedPitchFrame[] = []
    detected.forEach((frame) => {
      const previous = sampled[sampled.length - 1]
      if (!previous || frame.at - previous.at >= 100) sampled.push(frame)
      else if (frame.at >= durationMs - 100) sampled[sampled.length - 1] = frame
    })
    const points = sampled.map((frame) => ({ at: frame.at, left: 0.3 + frame.at / Math.max(1, durationMs) * 99.4, top: this.midiToChartTop(69 + 12 * Math.log(frame.frequency / 440) / Math.log(2)) }))
    const segments: PitchSegment[] = []
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]
      const current = points[index]
      if (current.at - previous.at > 650) continue
      const dx = current.left - previous.left
      const dy = (current.top - previous.top) * CHART_HEIGHT_RPX / chartWidthRpx
      segments.push({ key: index, left: previous.left, top: previous.top, width: Math.sqrt(dx * dx + dy * dy), angle: Math.atan2(dy, dx) * 180 / Math.PI })
    }
    return { segments, dots: points.length ? [points[points.length - 1]] : [] }
  },
  buildRecordingWav() {
    const dataBytes = this.recordedSampleCount * 2
    const buffer = new ArrayBuffer(44 + dataBytes)
    const view = new DataView(buffer)
    const writeText = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
    }
    writeText(0, 'RIFF')
    view.setUint32(4, 36 + dataBytes, true)
    writeText(8, 'WAVE')
    writeText(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, RECORD_SAMPLE_RATE, true)
    view.setUint32(28, RECORD_SAMPLE_RATE * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeText(36, 'data')
    view.setUint32(40, dataBytes, true)
    const output = new Int16Array(buffer, 44, this.recordedSampleCount)
    let offset = 0
    this.recordedPcmChunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length })
    return buffer
  },
  stopRecordingPlayback(showFeedback: boolean) {
    const wasPlaying = this.data.recordingPlayback
    this.pendingRecordingPlayback = false
    this.destroyRecordingPlayer()
    if (!wasPlaying) return
    this.setData({ recordingPlayback: false, inputLevel: 0, feedback: showFeedback ? '已停止回放，点击继续录音可以接着唱' : this.data.feedback, feedbackType: showFeedback ? 'idle' : this.data.feedbackType })
  },
  destroyRecordingPlayer() {
    const player = this.recordingPlayer
    this.recordingPlayer = null
    if (!player) return
    try {
      player.stop()
      player.destroy()
    } catch (error) {
      console.error('关闭练习录音播放器失败', error)
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
  analyzeSamples(samples: Int16Array, sampleRate: number, recordedAt: number | null = null) {
    let sum = 0
    for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / Math.max(1, Math.ceil(samples.length / 4))) / 32768
    const inputLevel = Math.min(100, Math.round(rms * 900))
    const waveformBars = this.buildWaveformBars(samples)
    const detected = this.detectPitch(samples, sampleRate)
    const targetIndex = this.data.mode === 'scale' ? this.scaleProgress.currentIndex() : 0
    const targetMidi = this.currentTargetMidi()
    const analyzedDurationMs = samples.length / Math.max(1, sampleRate) * 1000
    if (recordedAt !== null) this.recordedPitchFrames.push({ at: recordedAt, frequency: detected, level: inputLevel, targetMidi })
    if (detected) {
      this.detectedFrameCount++
      if (this.recordingWatchdog) clearTimeout(this.recordingWatchdog)
      this.recordingWatchdog = 0
      const target = 440 * Math.pow(2, (targetMidi - 69) / 12)
      const cents = Math.round(1200 * Math.log(detected / target) / Math.log(2))
      const history = this.data.pitchHistory.slice(-119).concat([detected])
      const chartDurationMs = Math.max(CHART_VIEW_SECONDS * 1000, recordedAt || this.data.seconds * 1000)
      const chartWidthRpx = this.chartWidthForDuration(chartDurationMs)
      const visual = this.buildRecordedPitchVisual(this.recordedPitchFrames, chartDurationMs, chartWidthRpx)
      const chartScrollLeft = this.data.chartFollowLatest ? this.chartScrollForPosition(chartWidthRpx, 1) : this.data.chartScrollLeft
      const inTune = Math.abs(cents) <= 20
      // 目标推进只依赖“已经检测到有效音高”，音准偏高/偏低仍然正常反馈，
      // 这样用户可以顺着音阶练习，而不会因为没唱准一直卡在 C3。
      const scaleResult = this.data.mode === 'scale' ? this.scaleProgress.observe(true, analyzedDurationMs) : null
      let feedback = this.pitchFeedback(cents)
      if (scaleResult && scaleResult.advanced) feedback = `很好，接下来唱 ${this.midiToNote(this.currentTargetMidi())}`
      if (scaleResult && scaleResult.completed) feedback = inTune ? '完整音阶唱完了，保持得很好' : '完整音阶唱完了，可以再听一次巩固音准'
      this.setData({ frameCount: this.data.frameCount + 1, voicedFrames: this.data.voicedFrames + 1, inTuneFrames: this.data.inTuneFrames + (inTune ? 1 : 0), inputLevel, waveformBars, pitchHistory: history, pitchSegments: visual.segments, pitchDots: visual.dots, chartHasSignal: true, currentNote: this.hzToNote(detected), targetNote: this.midiToNote(targetMidi), targetGuides: this.buildTargetGuides(), pitch: `${detected.toFixed(1)} Hz`, cents, feedback, feedbackType: inTune ? 'good' : 'off', scaleStep: scaleResult ? scaleResult.index + 1 : targetIndex + 1, scaleCompleted: !!(scaleResult && scaleResult.completed), chartWidthRpx, chartScrollLeft })
    } else {
      if (this.data.mode === 'scale') this.scaleProgress.observe(false, analyzedDurationMs)
      this.setData({ frameCount: this.data.frameCount + 1, inputLevel, waveformBars, targetNote: this.midiToNote(targetMidi), scaleStep: targetIndex + 1, feedback: rms > 0.008 ? '声音进来了，正在定位音高' : '请靠近麦克风唱出持续音', feedbackType: rms > 0.008 ? 'listening' : 'idle' })
    }
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
  buildTargetGuides(): TargetGuide[] {
    const rootMidi = this.noteToMidi(this.data.initialNote)
    const offsets = this.data.mode === 'scale' ? MAJOR_SCALE_OFFSETS : [0]
    const targetIndex = this.data.mode === 'scale' ? this.scaleProgress.currentIndex() : 0
    const midi = rootMidi + offsets[Math.min(targetIndex, offsets.length - 1)]
    return [{ label: this.midiToNote(midi), top: this.midiToChartTop(midi), stagger: false }]
  },
  chartWidthForDuration(durationMs: number) {
    const baseWidth = Math.max(CHART_VIEW_WIDTH_RPX, Math.ceil(durationMs / (CHART_VIEW_SECONDS * 1000) * CHART_VIEW_WIDTH_RPX))
    return Math.max(CHART_VIEW_WIDTH_RPX, Math.ceil(baseWidth * this.chartZoom))
  },
  chartScrollForPosition(chartWidthRpx: number, progress: number) {
    const cursorRpx = chartWidthRpx * Math.max(0, Math.min(1, progress))
    const maxScrollRpx = Math.max(0, chartWidthRpx - CHART_VIEW_WIDTH_RPX)
    const desiredRpx = Math.max(0, cursorRpx - CHART_VIEW_WIDTH_RPX * 0.78)
    return this.rpxToPx(Math.min(maxScrollRpx, desiredRpx))
  },
  rpxToPx(rpx: number) {
    const wxApi = wx as any
    const info = typeof wxApi.getWindowInfo === 'function' ? wxApi.getWindowInfo() : wx.getSystemInfoSync()
    return Math.round(rpx * info.windowWidth / 750)
  },
  onChartTouchStart(event: any) {
    const touches = event.touches || []
    if (touches.length >= 2) {
      this.chartPinchStartDistance = this.chartTouchDistance(touches)
      this.chartPinchStartZoom = this.chartZoom
      this.chartTouchStartX = null
      return
    }
    const touch = event.touches && event.touches[0]
    this.chartTouchStartX = touch ? touch.clientX : null
  },
  onChartTouchMove(event: any) {
    const touches = event.touches || []
    if (touches.length >= 2 && this.chartPinchStartDistance) {
      const distance = this.chartTouchDistance(touches)
      const zoom = Math.max(0.75, Math.min(4, this.chartPinchStartZoom * distance / this.chartPinchStartDistance))
      if (Math.abs(zoom - this.chartZoom) < 0.03) return
      this.chartZoom = zoom
      const durationMs = this.data.recordingPlayback
        ? Math.max(1, this.data.playbackDuration * 1000)
        : Math.max(CHART_VIEW_SECONDS * 1000, this.data.seconds * 1000)
      const chartWidthRpx = this.chartWidthForDuration(durationMs)
      this.setData({ chartWidthRpx, chartFollowLatest: false })
      return
    }
    if (this.chartTouchStartX === null || !this.data.chartFollowLatest || this.data.chartWidthRpx <= CHART_VIEW_WIDTH_RPX) return
    const touch = event.touches && event.touches[0]
    if (!touch || Math.abs(touch.clientX - this.chartTouchStartX) < 8) return
    this.setData({ chartFollowLatest: false })
  },
  onChartScroll(event: any) {
    if (event.detail && typeof event.detail.scrollLeft === 'number') this.chartCurrentScrollLeft = event.detail.scrollLeft
  },
  onChartTouchEnd() {
    this.chartTouchStartX = null
    this.chartPinchStartDistance = null
    if (!this.data.chartFollowLatest && Math.abs(this.data.chartScrollLeft - this.chartCurrentScrollLeft) > 1) {
      this.setData({ chartScrollLeft: this.chartCurrentScrollLeft })
    }
  },
  chartTouchDistance(touches: any[]) {
    const first = touches[0]
    const second = touches[1]
    const dx = Number(first.clientX || 0) - Number(second.clientX || 0)
    const dy = Number(first.clientY || 0) - Number(second.clientY || 0)
    return Math.max(1, Math.sqrt(dx * dx + dy * dy))
  },
  followLatestPitch() {
    const progress = this.data.recordingPlayback ? this.data.playbackProgress / 100 : 1
    this.setData({ chartFollowLatest: true, chartScrollLeft: this.chartScrollForPosition(this.data.chartWidthRpx, progress) })
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
  currentTargetMidi() {
    const rootMidi = this.noteToMidi(this.data.initialNote)
    if (this.data.mode !== 'scale') return rootMidi
    return rootMidi + MAJOR_SCALE_OFFSETS[this.scaleProgress.currentIndex()]
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
  pitchFeedback(cents: number) {
    const inTune = Math.abs(cents) <= 20
    if (this.feedbackMode === '少提示') return inTune ? '稳定' : cents < 0 ? '偏低' : '偏高'
    if (this.feedbackMode === '直接') return inTune ? '音准稳定' : cents < 0 ? `偏低 ${Math.abs(cents)} cents` : `偏高 ${cents} cents`
    return inTune ? '音准稳定，保持住' : cents < 0 ? `偏低 ${Math.abs(cents)} cents，再高一点` : `偏高 ${cents} cents，再低一点`
  },
  noteToHz(note: string) { const midi = this.noteToMidi(note); return 440 * Math.pow(2, (midi - 69) / 12) },
  noteToMidi(note: string) { const match = /^([A-G])(♯|#)?([1-6])$/.exec(note); if (!match) return 48; const semitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }; return (Number(match[3]) + 1) * 12 + semitones[match[1]] + (match[2] ? 1 : 0) },
  midiToNote(midi: number) { const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']; const rounded = Math.round(midi); return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}` },
  hzToNote(hz: number) { return this.midiToNote(69 + 12 * Math.log(hz / 440) / Math.log(2)) },
  finish() {
    this.resumeRecordingAfterDemo = false
    this.pendingRecordingPlayback = false
    this.stopRecordingPlayback(false)
    this.stopDemo()
    this.recordingRequested = false
    this.stopRecorder()
    this.stopElapsedTimer()
    const old = wx.getStorageSync('leta-stats') || {}
    const today = new Date().toDateString()
    const steadyPercent = this.data.voicedFrames > 0 ? Math.round(this.data.inTuneFrames / this.data.voicedFrames * 100) : 0
    this.setData({ finished: true, started: false, recording: false, recordingPlayback: false, demoPlaying: false, steadyPercent, feedback: '练习结束，做得很好' })
    wx.setStorageSync('leta-stats', { ...old, practiceMinutes: (old.practiceMinutes || 0) + Math.max(1, Math.round(this.data.seconds / 60)), practiceDays: old.lastPracticeDay === today ? (old.practiceDays || 0) : (old.practiceDays || 0) + 1, lastPracticeDay: today })
  },
  pause() {
    if (this.data.recordingPlayback) this.stopRecordingPlayback(false)
    if (this.data.demoPlaying) {
      this.resumeRecordingAfterDemo = false
      this.stopDemo()
      this.setData({ demoPlaying: false })
    }
    if (this.data.paused) {
      this.recordingRequested = true
      this.setData({ paused: false, feedback: '正在监听，请唱出当前音符', feedbackType: 'listening' })
      this.startRecorder()
      return
    }
    this.recordingRequested = false
    this.stopRecorder()
    this.stopElapsedTimer()
    this.setData({ paused: true, recording: false, feedback: '先休息一下，准备好再继续', feedbackType: 'idle' })
  },
  restartPractice() {
    this.resumeRecordingAfterDemo = false
    this.pendingRecordingPlayback = false
    this.stopRecordingPlayback(false)
    this.stopDemo()
    const waitForRecorder = this.recorderActive || this.recorderStarting
    this.pendingPracticeRestart = waitForRecorder
    this.recordingRequested = false
    this.stopElapsedTimer()
    this.setData({ paused: false, recording: false, demoPlaying: false, feedback: '正在重新开始…', feedbackType: 'listening' })
    this.stopRecorder()
    if (!waitForRecorder) this.beginPractice()
  },
  goBack() { this.pendingRecordingPlayback = false; this.stopRecordingPlayback(false); this.recordingRequested = false; this.stopRecorder(); wx.navigateBack() },
  goHome() { this.stopRecordingPlayback(false); wx.navigateBack() },
  restart() { this.stopRecordingPlayback(false); this.setData({ finished: false, progress: 0, seconds: 0 }); this.start() },
})
