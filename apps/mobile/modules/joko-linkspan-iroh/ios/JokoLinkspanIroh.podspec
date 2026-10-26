require 'json'

host = JSON.parse(File.read(File.join(__dir__, '../../../package.json')))
enabled = (ENV['JOKO_LINKSPAN_BUILD_BACKENDS'] || '').split(',').map(&:strip).include?('iroh-native')
generated = File.expand_path('generated', __dir__)
selection_file = File.join(generated, 'ios-selection.json')
selection = enabled && File.file?(selection_file) ? JSON.parse(File.read(selection_file)) : nil
raise 'Run the Mobile native Linkspan preparation before CocoaPods.' if enabled && (!selection || selection['platform'] != 'ios')
selected_path = lambda do |relative|
  path = File.expand_path(relative, generated)
  raise 'The selected native SDK escaped its build-owned directory.' unless path.start_with?(generated + File::SEPARATOR)
  File.join('generated', relative)
end

Pod::Spec.new do |s|
  s.name = 'JokoLinkspanIroh'
  # CocoaPods metadata belongs to this existing Joko host, never to Linkspan.
  s.version = host.fetch('version')
  s.summary = 'Joko host adapter for a selected native iroh stream bridge.'
  s.description = s.summary
  s.author = 'Joko'
  s.homepage = 'https://joko.app'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  if enabled
    runtime = selected_path.call(selection.fetch('runtimeDirectory'))
    sources = selected_path.call(selection.fetch('sourceDirectory'))
    notices = selected_path.call(selection.fetch('noticeDirectory'))
    s.source_files = [File.join(sources, '*.swift'), File.join(runtime, 'ios/IrohLib.swift')]
    s.vendored_frameworks = File.join(runtime, 'ios/Iroh.xcframework')
    s.frameworks = ['SystemConfiguration', 'Network']
    s.resource_bundles = { 'JokoLinkspanIrohNotices' => [File.join(notices, '*')] }
  else
    s.source_files = 'stub/*.swift'
  end
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
