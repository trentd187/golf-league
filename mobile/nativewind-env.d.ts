// nativewind-env.d.ts
// This file is a TypeScript declaration file (.d.ts) — it adds type definitions
// to the project without containing any runnable code.
//
// The triple-slash directive below tells the TypeScript compiler to include
// NativeWind's type definitions. Specifically, it adds the "className" prop
// to all React Native core components (View, Text, TouchableOpacity, etc.)
// so that TypeScript doesn't report an error when you write:
//   <View className="flex-1 bg-white" />
//
// Without this file, TypeScript would complain because "className" is not part
// of the standard React Native component prop types — it's a NativeWind addition.

/// <reference types="nativewind/types" />
