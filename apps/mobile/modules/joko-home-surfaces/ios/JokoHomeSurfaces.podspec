require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'JokoHomeSurfaces'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = 'MIT'
  s.author           = 'Joko'
  s.homepage         = 'https://joko.app'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks       = 'WidgetKit', 'ActivityKit'
  s.source_files     = '**/*.swift'
end
