// utils/alerts.ts
// Platform-aware alert helpers.
//
// Alert.alert is a complete no-op in react-native-web 0.21+ (static alert() {}).
// These utilities fall back to window.alert (informational) and window.confirm
// (destructive confirmations) so web users see feedback and can confirm actions.

import { Alert, Platform } from "react-native";

// showAlert displays a message with a single OK button — use for errors and info.
export function showAlert(title: string, message?: string): void {
  if (Platform.OS === "web") {
    window.alert(message ? `${title}: ${message}` : title);
    return;
  }
  Alert.alert(title, message, [{ text: "OK" }]);
}

// showConfirm displays a two-button confirmation dialog.
// onConfirm fires when the user accepts; nothing happens on cancel.
export function showConfirm(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmText = "OK",
  cancelText = "Cancel",
): void {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: cancelText, style: "cancel" },
    { text: confirmText, style: "destructive", onPress: onConfirm },
  ]);
}
