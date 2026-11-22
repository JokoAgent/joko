require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name          = 'JokoSpeakerOnnx'
  s.version       = package['version']
  s.summary       = 'On-device ONNX inference for the voice input speaker filter.'
  s.license       = 'Apache-2.0'
  s.author        = 'Joko'
  s.homepage      = 'https://joko.app'
  s.platforms     = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source        = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'onnxruntime-c', '1.30.0'
  s.pod_target_xcconfig = { 'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17' }
  s.source_files = '**/*.{h,mm,swift}'
end
