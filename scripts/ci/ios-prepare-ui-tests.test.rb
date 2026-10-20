require 'digest'
require 'open3'
require 'rbconfig'
require 'tmpdir'
require 'xcodeproj'

generator = File.expand_path('ios-prepare-ui-tests.rb', __dir__)
source = File.realpath(File.expand_path('ios-connection-ui-tests.swift', __dir__))
Dir.mktmpdir('joko-ui-project-') do |directory|
  path = File.join(directory, 'JokoCIUITests.xcodeproj')
  arguments = [path, source, '12345', '12346', '16.4']
  _, error, status = Open3.capture3(RbConfig.ruby, generator, *arguments)
  raise error unless status.success?
  project = Xcodeproj::Project.open(path)
  raise 'Expected only the real XCTest target.' unless project.targets.length == 1
  target = project.targets.first
  raise 'Expected an isolated UI-test bundle.' unless target.name == 'JokoCIUITests' && target.product_type == 'com.apple.product-type.bundle.ui-testing'
  raise 'The runner must not build an application dependency.' unless target.dependencies.empty?
  raise 'The original Swift UI operations must be used.' unless target.source_build_phase.files.map { |file| file.file_ref.real_path.to_s } == [source]
  target.build_configurations.each do |configuration|
    settings = configuration.build_settings
    raise 'Expected the artifact minimum OS version.' unless settings['IPHONEOS_DEPLOYMENT_TARGET'] == '16.4'
    raise 'The runner must attach by explicit bundle identity.' unless settings['TEST_TARGET_NAME'].nil? && settings['TEST_HOST'].nil?
  end
  scheme_path = File.join(path, 'xcshareddata', 'xcschemes', 'JokoCIUITests.xcscheme')
  scheme = Xcodeproj::XCScheme.new(scheme_path)
  references = REXML::XPath.match(scheme.doc, '//BuildableReference')
  raise 'The scheme must only build or test the XCTest target.' unless !references.empty? && references.all? { |reference| reference.attributes['BlueprintIdentifier'] == target.uuid }
  variables = REXML::XPath.match(scheme.doc, '//EnvironmentVariable').to_h { |element| [element.attributes['key'], element.attributes['value']] }
  raise 'The owned local servers must reach XCTest.' unless variables == { 'JOKO_CI_METRO_PORT' => '12345', 'JOKO_CI_PROBE_PORT' => '12346' }
  original = Digest::SHA256.file(File.join(path, 'project.pbxproj')).hexdigest
  _, _, status = Open3.capture3(RbConfig.ruby, generator, *arguments)
  raise 'An existing project must not be overwritten.' if status.success?
  raise 'The rejected project must remain unchanged.' unless original == Digest::SHA256.file(File.join(path, 'project.pbxproj')).hexdigest
  invalid = [File.join(directory, 'Invalid.xcodeproj'), source, '0', '12346', '16.4']
  _, _, status = Open3.capture3(RbConfig.ruby, generator, *invalid)
  raise 'An invalid server must not create a project.' if status.success? || File.exist?(invalid.first)
end
puts 'Isolated XCTest project, exact Swift source, local servers and non-overwrite checks passed.'
