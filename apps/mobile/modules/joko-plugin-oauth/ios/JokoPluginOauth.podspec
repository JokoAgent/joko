require 'json'
host = JSON.parse(File.read(File.join(__dir__, '..', '..', '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'JokoPluginOauth'
  s.version = host['version']
  s.summary = 'Bounded in-memory OAuth callback receiver'
  s.description = 'Receives an exact phone callback without tokens, PKCE secrets, cookies or persistence.'
  s.author = 'Joko'
  s.homepage = 'https://joko.app'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.frameworks = 'Network'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '*.swift'
end
