package com.guidey.app.unityview

/**
 * Unity -> React Native message bridge (string payload only).
 */
object UnityToReactBridge {
  @Volatile
  private var listener: ((Map<String, Any?>) -> Unit)? = null

  fun setListener(newListener: (Map<String, Any?>) -> Unit) {
    listener = newListener
  }

  fun clearListener(current: (Map<String, Any?>) -> Unit) {
    if (listener === current) {
      listener = null
    }
  }

  @JvmStatic
  fun emitMessage(message: String?) {
    val payload = mapOf("message" to message.orEmpty())
    listener?.invoke(payload)
  }
}
