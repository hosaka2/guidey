package com.guidey.app.unityview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.launch

class ExpoUnityViewModule : Module() {
  private val unityMessageListener: (Map<String, Any?>) -> Unit = { payload ->
    appContext.mainQueue.launch {
      sendEvent("unityMessage", payload)
    }
  }

  // Each module class must implement the definition function. The definition consists of components
  // that describes the module's functionality and behavior.
  // See https://docs.expo.dev/modules/module-api for more details about available components.
  override fun definition() = ModuleDefinition {
    // Sets the name of the module that JavaScript code will use to refer to the module. Takes a string as an argument.
    // Can be inferred from module's class name, but it's recommended to set it explicitly for clarity.
    // The module will be accessible from `requireNativeModule('ExpoUnityView')` in JavaScript.
    Name("ExpoUnityView")

    Events("unityMessage")

    OnCreate {
      UnityToReactBridge.setListener(unityMessageListener)
    }

    OnDestroy {
      UnityToReactBridge.clearListener(unityMessageListener)
    }

    AsyncFunction("sendUnityMessage") { message: Map<String, Any?> ->
      val objectName = (message["objectName"] as? String).orEmpty().trim()
      val methodName = (message["methodName"] as? String).orEmpty().trim()
      val body = (message["message"] as? String).orEmpty()

      require(objectName.isNotEmpty()) { "objectName is required" }
      require(methodName.isNotEmpty()) { "methodName is required" }

      if (!UnityManager.isInitialized()) {
        return@AsyncFunction
      }

      UnityManager.sendMessage(objectName, methodName, body)
    }

    // Unity → RN メッセージは OnCreate/OnDestroy で UnityToReactBridge にリスナーを
    // 登録済みなので、JS 側から明示的に購読開始/停止の呼び出しは不要。

    // No props/events on the view; pure rendering surface.
    View(ExpoUnityView::class) { }
  }
}
