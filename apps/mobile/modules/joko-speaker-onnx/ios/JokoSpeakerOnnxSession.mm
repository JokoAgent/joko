#import "JokoSpeakerOnnxSession.h"

#include <onnxruntime/onnxruntime_cxx_api.h>
#include <cstring>
#include <memory>
#include <vector>

namespace {
constexpr size_t kMaximumTensorElements = 1'000'000;
}

@implementation JokoSpeakerOnnxSession {
  std::unique_ptr<Ort::Session> _session;
}

+ (nullable instancetype)loadModelAtPath:(NSString *)path {
  try {
    static const Ort::Env environment{ORT_LOGGING_LEVEL_WARNING, "JokoSpeakerOnnx"};
    Ort::SessionOptions settings;
    settings.SetIntraOpNumThreads(1);
    JokoSpeakerOnnxSession *session = [[self alloc] init];
    session->_session = std::make_unique<Ort::Session>(environment, path.fileSystemRepresentation, settings);
    return session;
  } catch (const Ort::Exception&) {
    return nil;
  }
}

- (nullable NSDictionary<NSString *, NSDictionary<NSString *, id> *> *)
    runWithNames:(NSArray<NSString *> *)names
      dimensions:(NSArray<NSArray<NSNumber *> *> *)dimensions
           bytes:(NSData *)bytes {
  if (!_session || names.count != dimensions.count || names.count == 0
      || names.count > 8 || bytes.length > kMaximumTensorElements * sizeof(float)) return nil;
  try {
    const auto memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::vector<Ort::Value> inputs;
    std::vector<const char *> inputNames;
    std::vector<std::vector<float>> inputBuffers;
    inputBuffers.reserve(names.count);
    size_t offset = 0;
    for (NSUInteger index = 0; index < names.count; index++) {
      NSArray<NSNumber *> *dimensionsForInput = dimensions[index];
      if (dimensionsForInput.count == 0 || dimensionsForInput.count > 4) return nil;
      std::vector<int64_t> shape;
      size_t count = 1;
      for (NSNumber *dimension in dimensionsForInput) {
        const auto value = dimension.longLongValue;
        if (value < 1 || value > kMaximumTensorElements / count) return nil;
        shape.push_back(value);
        count *= value;
      }
      const size_t byteCount = count * sizeof(float);
      if (byteCount > bytes.length - offset) return nil;
      auto &input = inputBuffers.emplace_back(count);
      std::memcpy(input.data(), static_cast<const char *>(bytes.bytes) + offset, byteCount);
      offset += byteCount;
      const char *name = names[index].UTF8String;
      if (name == nullptr || *name == '\0') return nil;
      inputNames.push_back(name);
      inputs.push_back(Ort::Value::CreateTensor<float>(memory, input.data(), count, shape.data(), shape.size()));
    }
    if (offset != bytes.length) return nil;

    Ort::AllocatorWithDefaultOptions allocator;
    const auto outputCount = _session->GetOutputCount();
    std::vector<Ort::AllocatedStringPtr> allocatedNames;
    std::vector<const char *> outputNames;
    for (size_t index = 0; index < outputCount; index++) {
      allocatedNames.push_back(_session->GetOutputNameAllocated(index, allocator));
      outputNames.push_back(allocatedNames.back().get());
    }
    auto outputs = _session->Run(Ort::RunOptions{nullptr}, inputNames.data(), inputs.data(), inputs.size(),
                                  outputNames.data(), outputNames.size());
    NSMutableDictionary<NSString *, NSDictionary<NSString *, id> *> *result = [NSMutableDictionary dictionary];
    for (size_t index = 0; index < outputs.size(); index++) {
      const auto &output = outputs[index];
      const auto info = output.GetTensorTypeAndShapeInfo();
      if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT || info.GetElementCount() > kMaximumTensorElements) return nil;
      NSString *name = [NSString stringWithUTF8String:outputNames[index]];
      if (name == nil) return nil;
      NSMutableArray<NSNumber *> *dims = [NSMutableArray array];
      for (const auto value : info.GetShape()) [dims addObject:@(value)];
      NSData *data = [NSData dataWithBytes:output.GetTensorData<float>() length:info.GetElementCount() * sizeof(float)];
      result[name] = @{ @"dims": dims, @"base64": [data base64EncodedStringWithOptions:0] };
    }
    return result;
  } catch (const Ort::Exception&) {
    return nil;
  }
}

@end
