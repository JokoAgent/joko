require 'json'
host = JSON.parse(File.read(File.join(__dir__, '../../../package.json')))
selected = (ENV['JOKO_LINKSPAN_BUILD_BACKENDS'] || '').split(',').map(&:strip).include?('http-connect-native')
Pod::Spec.new do |s|
  s.name = 'JokoLinkspanHttpConnect'
  s.version = host.fetch('version')
  s.summary = 'Joko host adapter for an explicitly selected proxy byte stream.'
  s.description = s.summary
  s.author = 'Joko'
  s.homepage = 'https://joko.app'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = selected ? 'selected/*.swift' : 'stub/*.swift'
  s.frameworks = ['Network', 'Security'] if selected
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
