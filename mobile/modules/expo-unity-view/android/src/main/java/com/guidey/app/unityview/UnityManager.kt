package com.guidey.app.unityview

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import com.unity3d.player.UnityPlayer
import com.unity3d.player.UnityPlayerForActivityOrService

/**
 * Single UnityPlayer instance shared across all ExpoUnityView instances.
 */
object UnityManager {
  @Volatile
  private var unityPlayer: UnityPlayerForActivityOrService? = null
  private val lock = Any()

  fun isInitialized(): Boolean = unityPlayer != null

  /**
   * RN の ThemedReactContext のように ContextWrapper でラップされた Context から
   * 元の Activity を取り出す。XREAL SDK の NRDefaultFloatingViewProxy は Activity で
   * なければ getSystemService で NPE を起こすため必須。
   */
  private fun unwrapActivity(context: Context): Context {
    var c: Context = context
    while (c is ContextWrapper) {
      if (c is Activity) return c
      c = c.baseContext
    }
    return context
  }

  /**
   * XREAL SDK (XREALXRLoader.Initialize) が `UnityPlayer.currentActivity` static を参照し、
   * null だと NullReferenceException。UaaL 構成では誰もセットしないので明示的に入れる。
   */
  private fun setCurrentActivityReflectively(activity: Activity) {
    try {
      val field = UnityPlayer::class.java.getDeclaredField("currentActivity")
      field.isAccessible = true
      val before = field.get(null)
      field.set(null, activity)
      val after = field.get(null)
      android.util.Log.i(
        "UnityManager",
        "UnityPlayer.currentActivity set: before=$before, after=$after"
      )
    } catch (e: Exception) {
      android.util.Log.w("UnityManager", "Failed to set UnityPlayer.currentActivity: ${e.message}")
    }
  }

  private fun obtainPlayer(context: Context): UnityPlayerForActivityOrService {
    synchronized(lock) {
      if (unityPlayer == null) {
        val unwrapped = unwrapActivity(context)
        if (unwrapped is Activity) {
          // UnityPlayer 作成**前**にセット (XR Loader 初期化時に読まれるため)
          setCurrentActivityReflectively(unwrapped)
        } else {
          android.util.Log.w("UnityManager", "context is not Activity: ${unwrapped.javaClass.name}")
        }
        unityPlayer = UnityPlayerForActivityOrService(unwrapped)
        // コンストラクタで currentActivity がリセットされる可能性があるので再セット
        if (unwrapped is Activity) {
          setCurrentActivityReflectively(unwrapped)
        }
      }
      return requireNotNull(unityPlayer)
    }
  }

  fun ensureInitialized(context: Context) {
    val mainLooper = Looper.getMainLooper()
    if (Looper.myLooper() != mainLooper) {
      Handler(mainLooper).post { ensureInitialized(context) }
      return
    }
    obtainPlayer(context)
  }

  fun obtainView(context: Context): View {
    check(Looper.myLooper() == Looper.getMainLooper()) { "Unity view must be obtained on main thread" }
    val player = obtainPlayer(context)
    val playerView = player.view
    (playerView.parent as? ViewGroup)?.removeView(playerView)
    return playerView
  }

  fun sendMessage(objectName: String, methodName: String, message: String) {
    UnityPlayer.UnitySendMessage(objectName, methodName, message)
  }

  fun resume() {
    unityPlayer?.resume()
  }

  fun pause() {
    unityPlayer?.pause()
  }

  fun windowFocusChanged(hasFocus: Boolean) {
    unityPlayer?.windowFocusChanged(hasFocus)
  }

  /**
   * UnityPlayer 配下の SurfaceView を最背面に固定する。
   *
   * Android の SurfaceView は通常 View より下 (別 Window) に描画されるが、
   * UnityPlayer (と XREAL XR Loader) が内部で setZOrderOnTop(true) 相当を
   * 呼ぶことがあり、RN View が SurfaceView に隠されて見えなくなる現象がある。
   * Activity 再構築や RN reload 後に再発するため、Attach のたびに明示 reset。
   *
   * 効果: RN UI がグラス (スクリーンキャスト) にそのまま映り、Unity は裏で
   * 撮影等の処理だけ続行できる。
   */
  fun forceSurfaceBackground() {
    val root = unityPlayer?.view ?: return
    fun walk(v: View) {
      if (v is android.view.SurfaceView) {
        try {
          v.setZOrderMediaOverlay(false)
          v.setZOrderOnTop(false)
        } catch (e: Exception) {
          android.util.Log.w("UnityManager", "setZOrder reset failed: ${e.message}")
        }
      }
      if (v is ViewGroup) {
        for (i in 0 until v.childCount) walk(v.getChildAt(i))
      }
    }
    walk(root)
  }

  fun destroy() {
    synchronized(lock) {
      unityPlayer?.destroy()
      unityPlayer = null
    }
  }
}
