import { useState, useEffect, useRef, useCallback } from 'react'
import {
  SpeechRecognition,
  SpeechRecognitionErrorEvent,
  SpeechRecognitionEvent
} from '../chatPageShared'

/**
 * 语音识别 Hook
 */
export function useSpeechRecognition(
  setInputValue: React.Dispatch<React.SetStateAction<string>>,
  t: (key: string) => string,
  active: boolean = true
) {
  const [isListening, setIsListening] = useState(false)
  const [speechRecognitionSupported, setSpeechRecognitionSupported] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const interimTranscriptRef = useRef<string>('')
  const activeRef = useRef(active)

  useEffect(() => {
    activeRef.current = active
    if (!active && recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (_e) {
        // ignore
      }
      setIsListening(false)
      interimTranscriptRef.current = ''
    }
  }, [active])

  useEffect(() => {
    try {
      const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition
      setSpeechRecognitionSupported(!!SpeechRecognitionCtor)

      if (SpeechRecognitionCtor) {
        const recognition = new SpeechRecognitionCtor() as SpeechRecognition
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = navigator.language || 'zh-CN'

        recognition.onstart = () => {
          if (!activeRef.current) {
            try {
              recognition.stop()
            } catch (_e) {
              // ignore
            }
            return
          }
          setIsListening(true)
          interimTranscriptRef.current = ''
        }

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          if (!activeRef.current) return
          let interimTranscript = ''
          let finalTranscript = interimTranscriptRef.current

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript
            if (event.results[i].isFinal) {
              finalTranscript += transcript + ' '
            } else {
              interimTranscript += transcript
            }
          }

          const fullText =
            finalTranscript.trim() + (interimTranscript ? ' ' + interimTranscript : '')
          if (fullText.trim()) {
            setInputValue((prev: string) => {
              const baseText = prev.replace(interimTranscriptRef.current, '').trim()
              return baseText ? `${baseText} ${fullText}`.trim() : fullText
            })
          }
          interimTranscriptRef.current = finalTranscript
        }

        recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
          if (!activeRef.current) return
          console.error('[ChatPage] Speech recognition error:', event.error)
          if (event.error === 'no-speech' || event.error === 'audio-capture') {
            return
          }
          setIsListening(false)
          if (recognitionRef.current) {
            try {
              recognitionRef.current.stop()
            } catch (_e) {
              // ignore
            }
          }
        }

        recognition.onend = () => {
          setIsListening(false)
          interimTranscriptRef.current = ''
        }

        recognitionRef.current = recognition
      }
    } catch (error) {
      console.error('[ChatPage] Failed to initialize speech recognition:', error)
      setSpeechRecognitionSupported(false)
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
        } catch (_e) {
          // ignore
        }
      }
    }
  }, [setInputValue])

  const toggleSpeechRecognition = useCallback(() => {
    if (!active) return
    if (!recognitionRef.current) return

    if (isListening) {
      try {
        recognitionRef.current.stop()
        setIsListening(false)
      } catch (error) {
        console.error('[ChatPage] Error stopping speech recognition:', error)
        setIsListening(false)
      }
    } else {
      try {
        recognitionRef.current.start()
      } catch (error) {
        console.error('[ChatPage] Error starting speech recognition:', error)
        alert(t('chat.speech_recognition_error'))
      }
    }
  }, [active, isListening, t])

  return {
    isListening,
    speechRecognitionSupported,
    toggleSpeechRecognition
  }
}
