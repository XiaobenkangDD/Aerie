import Foundation
import AppKit
import CoreImage
import Vision

// 用 `swift` 直接解释执行，不把 OCR 引擎打进应用。
// macOS 自带 Vision。脚本跑不起来时主进程会跳过，并在界面上说明原因。
//
// 退出码：
//   0  识别完成（没有文字也算完成，stdout 为空）
//   2  这张图读不了，换下一张
//   1  Vision 或参数有问题，调用方应停掉整轮，不要对每张图都重试

let args = CommandLine.arguments
if args.count < 2 {
    fputs("缺少图片路径\n", stderr)
    exit(1)
}

let url = URL(fileURLWithPath: args[1])
guard let image = NSImage(contentsOf: url),
      let tiff = image.tiffRepresentation,
      let ciImage = CIImage(data: tiff) else {
    fputs("读不到图片\n", stderr)
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
// 素材库里中文和英文都常见，两种一起开，避免中文截图被识别成乱码。
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("Vision 失败：\(error.localizedDescription)\n", stderr)
    exit(1)
}

let lines = (request.results ?? []).compactMap { observation -> String? in
    observation.topCandidates(1).first?.string
}
print(lines.joined(separator: "\n"))
