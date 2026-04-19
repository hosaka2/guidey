using System;
using System.Collections;
using System.IO;
using System.Linq;
using UnityEngine;
#if !UNITY_EDITOR && UNITY_ANDROID
using Unity.XR.XREAL;
#endif

/// <summary>
/// guidey <-> XREAL SDK のカメラブリッジ。
///
/// RN 側からの postMessage("CameraBridge", "&lt;method&gt;", "&lt;json args&gt;") を受け取り、
/// XREAL Eye カメラで 1 フレーム撮影、PNG バイナリを取得して JPEG に再エンコード、
/// file:// URI を SendMessageToMobileApp で返す。
///
/// === XREAL SDK 3.x (Unity.XR.XREAL) の API ===
/// 用途に合わせて 2 種類の API がある:
///   - XREALRGBCameraTexture: ライブプレビュー用 (YUV_420_888 3 plane)
///   - XREALPhotoCapture    : 単発の写真撮影 (PNG バイナリ直接取得)  ← こちらを使う
///
/// 参考: Samples~/Camera Features/RGBCameraAndCapture/Scripts/CaptureExample.cs
///
/// === デバッグ戦略 ===
/// Editor では SDK が動かないので mock 画像を返す。
/// 実機では全段階で Debug.Log を出すので:
///
///   adb logcat Unity:V CameraBridge:V *:S
/// </summary>
public class CameraBridge : MonoBehaviour
{
    // === Bridge payload ===
    [Serializable] private class Request { public string id; public string method; }
    [Serializable] private class CaptureData { public string uri; }
    [Serializable] private class ReadyData { public bool ready; public string reason; }
    [Serializable]
    private class Response
    {
        public string id;
        public string kind;
        public string data;
        public string error;
    }

    // Start 時にセッション生成まで終わったら true (PhotoCapture は撮影ごとに作る)
    private bool _cameraReady = false;
    private string _initError = null;

#if !UNITY_EDITOR && UNITY_ANDROID
    private XREALPhotoCapture _photoCapture;
    private UnityEngine.Resolution _cameraResolution;
    private bool _photoInProgress = false;
#endif

    // === Lifecycle ===

    private void Start()
    {
        Debug.Log("[CameraBridge] Start() called");
#if !UNITY_EDITOR && UNITY_ANDROID
        StartCoroutine(InitXrealCamera());
#else
        _cameraReady = true;
        Debug.Log("[CameraBridge] (editor) mock ready");
#endif
    }

    private void OnDestroy()
    {
#if !UNITY_EDITOR && UNITY_ANDROID
        try
        {
            _photoCapture?.Dispose();
            _photoCapture = null;
        }
        catch (Exception e)
        {
            Debug.LogWarning("[CameraBridge] Dispose failed: " + e.Message);
        }
#endif
        _cameraReady = false;
    }

#if !UNITY_EDITOR && UNITY_ANDROID
    /// <summary>
    /// XREAL の PhotoCapture 利用には解像度一覧が取れるまで少し待つ必要がある。
    /// グラス未接続だと SupportedResolutions が空のはず。
    /// </summary>
    private IEnumerator InitXrealCamera()
    {
        int waitFrames = 0;
        while (waitFrames < 120)
        {
            try
            {
                var resolutions = XREALPhotoCapture.SupportedResolutions;
                if (resolutions != null && resolutions.Count() > 0)
                {
                    _cameraResolution = resolutions.OrderByDescending(r => r.width * r.height).First();
                    _cameraReady = true;
                    // DEBUG: RGB Camera 機能サポート判定 (Blend mode が VirtualOnly に強制される原因)
                    try
                    {
                        bool rgbSupported = XREALPlugin.IsHMDFeatureSupported(XREALSupportedFeature.XREAL_FEATURE_RGB_CAMERA);
                        Debug.Log("[CameraBridge] IsHMDFeatureSupported(RGB_CAMERA)=" + rgbSupported
                            + ", resolution=" + _cameraResolution.width + "x" + _cameraResolution.height);
                    }
                    catch (Exception e) { Debug.LogWarning("[CameraBridge] feature check: " + e.Message); }
                    yield break;
                }
            }
            catch (Exception)
            {
                // まだ SDK 準備中。次フレームで再試行。
            }
            yield return null;
            waitFrames++;
        }

        _initError = "XREALPhotoCapture.SupportedResolutions empty (glasses connected?)";
        Debug.LogWarning("[CameraBridge] " + _initError);
    }
#endif

    // === RN から postMessage で呼ばれる method 群 ===

    public void Capture(string json)
    {
        Debug.Log("[CameraBridge] Capture() called, payload=" + (json ?? "").Length + "B");
        var req = TryParse(json);
        if (req == null) return;
        StartCoroutine(CaptureCoroutine(req.id));
    }

    public void IsReady(string json)
    {
        Debug.Log("[CameraBridge] IsReady() called");
        var req = TryParse(json);
        if (req == null) return;
        var payload = new ReadyData { ready = _cameraReady, reason = _initError };
        Reply(req.id, JsonUtility.ToJson(payload), null);
    }

    // === Internal ===

    private static Request TryParse(string json)
    {
        try { return JsonUtility.FromJson<Request>(json); }
        catch (Exception e)
        {
            Debug.LogWarning("[CameraBridge] bad payload: " + e.Message);
            return null;
        }
    }

    private IEnumerator CaptureCoroutine(string requestId)
    {
        if (!_cameraReady)
        {
            var msg = _initError ?? "camera not ready";
            Debug.LogWarning("[CameraBridge] Capture abort: " + msg);
            Reply(requestId, null, msg);
            yield break;
        }

#if !UNITY_EDITOR && UNITY_ANDROID
        if (_photoInProgress)
        {
            Reply(requestId, null, "already capturing");
            yield break;
        }
        _photoInProgress = true;
        yield return StartCoroutine(CaptureAndroidCoroutine(requestId));
        _photoInProgress = false;
#else
        // Editor 用のモック画像
        var tex = new Texture2D(128, 128);
        var pixels = new Color[128 * 128];
        for (int i = 0; i < pixels.Length; i++) pixels[i] = Color.cyan;
        tex.SetPixels(pixels);
        tex.Apply();
        var jpg = tex.EncodeToJPG(70);
        WriteAndReply(requestId, jpg);
#endif
    }

#if !UNITY_EDITOR && UNITY_ANDROID
    /// <summary>
    /// XREALPhotoCapture で 1 フレーム撮影。非同期コールバックを coroutine 風に扱う。
    /// フロー: Create → StartPhotoMode → TakePhoto → (TextureData を JPEG 再エンコードして保存) → StopPhotoMode → Dispose
    /// </summary>
    private IEnumerator CaptureAndroidCoroutine(string requestId)
    {
        bool done = false;
        string capturedPath = null;
        string err = null;

        // 1. PhotoCapture instance 作成
        XREALPhotoCapture.CreateAsync(false, captureObj =>
        {
            if (captureObj == null)
            {
                err = "CreateAsync returned null";
                done = true;
                return;
            }
            _photoCapture = captureObj;

            // 2. PhotoMode 起動
            var param = new CameraParameters
            {
                cameraType = Unity.XR.XREAL.CameraType.RGB,
                hologramOpacity = 0.0f,
                frameRate = NativeConstants.RECORD_FPS_DEFAULT,
                cameraResolutionWidth = _cameraResolution.width,
                cameraResolutionHeight = _cameraResolution.height,
                pixelFormat = CapturePixelFormat.PNG,
                // CameraOnly は SDK 側で AutoAdaptBlendMode で VirtualOnly に勝手に変換され
                // 結果真っ黒な画像になる (Unity シーンが空なため)。
                // Blend を使ってカメラ映像+ホログラム合成にする。hologramOpacity=0 なので
                // 実質カメラ映像だけが記録される。
                blendMode = BlendMode.Blend,
                audioState = AudioState.None,
                captureSide = CaptureSide.Single,
                backgroundColor = Color.black,
            };

            _photoCapture.StartPhotoModeAsync(param, startRes =>
            {
                if (!startRes.success)
                {
                    err = "StartPhotoMode failed: " + startRes.resultType;
                    done = true;
                    return;
                }

                // 3. 撮影
                _photoCapture.TakePhotoAsync((takeRes, frame) =>
                {
                    if (!takeRes.success || frame?.TextureData == null)
                    {
                        err = "TakePhoto failed: " + (takeRes.resultType.ToString());
                        FinishCapture();
                        return;
                    }

                    try
                    {
                        // frame.TextureData は PNG バイトだが、そのまま保存でも OK。
                        // ここでは互換性優先で JPEG に再エンコード (サイズ削減)。
                        var tex = new Texture2D(_cameraResolution.width, _cameraResolution.height);
                        frame.UploadImageDataToTexture(tex);
                        byte[] jpg = tex.EncodeToJPG(70);

                        string dir = Path.Combine(Application.temporaryCachePath, "xreal");
                        Directory.CreateDirectory(dir);
                        string path = Path.Combine(dir, "frame-" + Guid.NewGuid().ToString("N") + ".jpg");
                        File.WriteAllBytes(path, jpg);
                        capturedPath = path;
                        Debug.Log($"[CameraBridge] captured {jpg.Length}B → {path}");
                    }
                    catch (Exception e)
                    {
                        err = "encode/save failed: " + e.Message;
                    }

                    FinishCapture();
                });
            }, true);
        });

        // コールバック完了を待つ (最大 10 秒)
        float elapsed = 0f;
        while (!done && elapsed < 10f)
        {
            yield return null;
            elapsed += Time.deltaTime;
        }

        if (!done)
        {
            err = "timeout after 10s";
        }

        if (err != null)
        {
            Debug.LogWarning("[CameraBridge] capture error: " + err);
            Reply(requestId, null, err);
        }
        else
        {
            var data = new CaptureData { uri = "file://" + capturedPath };
            Reply(requestId, JsonUtility.ToJson(data), null);
        }

        // coroutine ローカルで使う完了フラグ
        void FinishCapture()
        {
            _photoCapture?.StopPhotoModeAsync(_ =>
            {
                _photoCapture?.Dispose();
                _photoCapture = null;
                done = true;
            });
        }
    }
#else
    // Editor 経路: モック生成後に即返す
    private void WriteAndReply(string requestId, byte[] jpg)
    {
        try
        {
            string dir = Path.Combine(Application.temporaryCachePath, "xreal");
            Directory.CreateDirectory(dir);
            string path = Path.Combine(dir, "frame-" + Guid.NewGuid().ToString("N") + ".jpg");
            File.WriteAllBytes(path, jpg);
            var data = new CaptureData { uri = "file://" + path };
            Debug.Log("[CameraBridge] (editor) Reply capture uri=" + path + " (" + jpg.Length + "B)");
            Reply(requestId, JsonUtility.ToJson(data), null);
        }
        catch (Exception e)
        {
            Reply(requestId, null, "save failed: " + e.Message);
        }
    }
#endif

    private void Reply(string id, string dataJson, string error)
    {
        var res = new Response { id = id, kind = "camera", data = dataJson, error = error };
        UnityInterop.SendToRN(JsonUtility.ToJson(res));
    }
}
