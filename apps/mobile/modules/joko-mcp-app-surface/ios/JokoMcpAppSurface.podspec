require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'JokoMcpAppSurface'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.author = 'Joko'
  s.homepage = 'https://joko.app'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.frameworks = 'Network'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  s.resource_bundles = { 'JokoMcpAppSurfaceNotices' => ['../LICENSE'] }
end
