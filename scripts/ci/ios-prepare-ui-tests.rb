require 'xcodeproj'

# Build only XCTest without requiring Pods or producing a replacement app.
# Runtime tests attach to the installed application on the owned device.
abort 'Expected new project, Swift source, Metro port, local probe port, minimum OS version and optional selected runtime.' unless (5..6).cover?(ARGV.length)
project_path, source_path, metro_port, probe_port, deployment, selected_runtime = ARGV
selected_runtime ||= 'relay'
abort 'Unknown selected Mobile runtime.' unless ['relay', 'iroh-native', 'http-connect-native'].include?(selected_runtime)
abort 'Expected a new project and real CI Swift source.' if File.exist?(project_path) || !File.file?(source_path)
abort 'Expected owned local server ports.' unless [metro_port, probe_port].all? { |port| port.match?(/\A[0-9]+\z/) && (1..65_535).cover?(port.to_i) }
abort 'Expected the compiled application minimum OS version.' unless deployment.match?(/\A[0-9]{1,2}(?:\.[0-9]{1,2}){1,2}\z/)
project = Xcodeproj::Project.new(project_path)
target = project.new_target(:ui_test_bundle, 'JokoCIUITests', :ios, deployment, nil, :swift)
target.source_build_phase.add_file_reference(project.main_group.new_file(File.realpath(source_path)))
target.build_configurations.each do |configuration|
  configuration.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'app.joko.mobile.ciuitests',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'ENABLE_TESTING_SEARCH_PATHS' => 'YES',
    'CODE_SIGNING_ALLOWED' => 'YES',
    'CODE_SIGNING_REQUIRED' => 'NO',
    'CODE_SIGN_IDENTITY' => '-',
    'DEVELOPMENT_TEAM' => '',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks'],
    'FRAMEWORK_SEARCH_PATHS' => ['$(inherited)', '$(PLATFORM_DIR)/Developer/Library/Frameworks']
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(nil, target)
scheme.test_action.build_configuration = 'Debug'
scheme.test_action.should_use_launch_scheme_args_env = false
scheme.test_action.environment_variables = Xcodeproj::XCScheme::EnvironmentVariables.new([
  { :key => 'JOKO_CI_METRO_PORT', :value => metro_port },
  { :key => 'JOKO_CI_PROBE_PORT', :value => probe_port },
  { :key => 'JOKO_CI_SDK_RUNTIME', :value => selected_runtime }
])
scheme.save_as(project.path, 'JokoCIUITests', true)
puts 'Created the isolated JokoCIUITests project; it builds no application target.'
