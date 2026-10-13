Pod::Spec.new do |s|
  s.name = 'JokoRemoteCredentials'
  s.version = '0.1.0'
  s.summary = 'Native device identity and remote desktop credential transactions.'
  s.description = 'Native encrypted sessions, password entry and protected credential storage.'
  s.author = 'Joko'
  s.homepage = 'https://joko.app'
  s.source = { :path => '.' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = 'Sources/JokoRemoteCredentials/**/*.swift'
  s.resource_bundles = { 'JokoRemoteCredentialsResources' => ['Sources/JokoRemoteCredentials/Resources/*.json'] }
  s.dependency 'JOSESwift', '= 3.0.0'
end
