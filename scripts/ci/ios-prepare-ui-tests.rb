require 'xcodeproj'

# Add an isolated Apple UI-test runner to the generated project. The application
# has already been built and installed; this scheme builds only the test runner.
abort 'Expected generated project, Swift source, Metro port and local probe port.' unless ARGV.length == 4
project_path, source_path, metro_port, probe_port = ARGV
abort 'Expected real generated project and CI Swift source.' unless File.directory?(project_path) && File.file?(source_path)
abort 'Expected owned local server ports.' unless [metro_port, probe_port].all? { |port| port.match?(/\A[0-9]+\z/) && (1..65_535).cover?(port.to_i) }
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.product_type == 'com.apple.product-type.application' && target.name == 'Joko' }
abort 'The generated Joko application target is missing.' unless app
abort 'The CI UI-test target already exists.' if project.targets.any? { |target| target.name == 'JokoCIUITests' }
deployment = app.build_configurations.find { |configuration| configuration.name == 'Debug' }.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] || '15.1'
target = project.new_target(:ui_test_bundle, 'JokoCIUITests', :ios, deployment, nil, :swift)
target.source_build_phase.add_file_reference(project.main_group.new_file(File.realpath(source_path)))
target.build_configurations.each do |configuration|
  configuration.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'app.joko.mobile.ciuitests',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'TEST_TARGET_NAME' => app.name,
    'ENABLE_TESTING_SEARCH_PATHS' => 'YES',
    'CODE_SIGNING_ALLOWED' => 'YES',
    'CODE_SIGNING_REQUIRED' => 'NO',
    'CODE_SIGN_IDENTITY' => '-',
    'DEVELOPMENT_TEAM' => '',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks'],
    'FRAMEWORK_SEARCH_PATHS' => ['$(inherited)', '$(PLATFORM_DIR)/Developer/Library/Frameworks']
  })
end
project.root_object.attributes['TargetAttributes'] ||= {}
project.root_object.attributes['TargetAttributes'][target.uuid] = { 'TestTargetID' => app.uuid }
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(nil, target)
scheme.test_action.build_configuration = 'Debug'
scheme.test_action.should_use_launch_scheme_args_env = false
scheme.test_action.environment_variables = Xcodeproj::XCScheme::EnvironmentVariables.new([
  { :key => 'JOKO_CI_METRO_PORT', :value => metro_port },
  { :key => 'JOKO_CI_PROBE_PORT', :value => probe_port }
])
scheme.save_as(project.path, 'JokoCIUITests', true)
puts 'Created the isolated JokoCIUITests scheme; original application targets were not changed.'
