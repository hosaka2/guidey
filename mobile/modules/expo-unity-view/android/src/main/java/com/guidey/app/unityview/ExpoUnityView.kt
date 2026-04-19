package com.guidey.app.unityview

import android.content.Context
import android.view.View
import android.view.ViewGroup.LayoutParams
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class ExpoUnityView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var unityView: View? = null

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    UnityManager.ensureInitialized(context)
    attachUnityView()
    UnityManager.resume()
    // Unity SurfaceView を最背面に固定 (RN UI 優先でグラスに映すため)。
    // post + 次 frame でも念のため再実行 (XR Loader の初期化後に戻される場合あり)。
    UnityManager.forceSurfaceBackground()
    post {
      UnityManager.forceSurfaceBackground()
      UnityManager.windowFocusChanged(true)
      unityView?.requestFocus()
    }
  }

  override fun onDetachedFromWindow() {
    UnityManager.pause()
    UnityManager.windowFocusChanged(false)
    detachUnityView()
    super.onDetachedFromWindow()
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    UnityManager.windowFocusChanged(hasWindowFocus)
  }

  private fun attachUnityView() {
    val playerView = UnityManager.obtainView(context)
    if (playerView.parent === this) {
      unityView = playerView
      return
    }
    removeAllViews()
    unityView = playerView
    playerView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    addView(playerView)
  }

  private fun detachUnityView() {
    unityView?.let { view ->
      if (view.parent === this) {
        removeView(view)
      }
    }
    unityView = null
  }
}
