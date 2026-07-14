import 'package:flutter/material.dart';

/// Design tokens shared with the web redesign (customer-web/globals.css
/// `--pos-*`). Keep the two in sync when the palette changes.
class PosColors {
  PosColors._();

  // Brand & neutrals
  static const ink = Color(0xFF181C34);
  static const inkSoft = Color(0xFF494F6B);
  static const muted = Color(0xFF858CA6);
  static const bg = Color(0xFFF3F4FA);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceAlt = Color(0xFFF8F9FD);
  static const border = Color(0xFFE6E8F2);
  static const borderStrong = Color(0xFFD4D8E8);

  // Primary navy/indigo
  static const navy1 = Color(0xFF1C2342);
  static const navy2 = Color(0xFF2C3567);
  static const navy3 = Color(0xFF3B447F);

  // Accent (brand orange)
  static const accent = Color(0xFFE85D04);
  static const accentDark = Color(0xFFC84F00);
  static const accentSoft = Color(0xFFFFF1E6);

  // Status
  static const gold = Color(0xFFF5B333);
  static const goldSoft = Color(0xFFFDF3DC);
  static const green = Color(0xFF0FB98C);
  static const greenDark = Color(0xFF077A5D);
  static const greenSoft = Color(0xFFE2F8F0);
  static const red = Color(0xFFE5476B);
  static const redDark = Color(0xFFC23054);
  static const redSoft = Color(0xFFFDECF1);
  static const blue = Color(0xFF3F7DE0);

  // Dark surfaces (kitchen display)
  static const darkBg = Color(0xFF0C0F20);
  static const darkSurface = Color(0xFF161C38);
  static const darkSurface2 = Color(0xFF222A52);

  // Navy gradient used for headers / primary buttons.
  static const navyGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF181E3A), Color(0xFF242C58), Color(0xFF33396F)],
  );
  static const accentGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [accent, Color(0xFFF0750F)],
  );
}

class PosRadii {
  PosRadii._();
  static const lg = 18.0;
  static const md = 14.0;
  static const sm = 10.0;
}

const kFontFamily = 'NotoSansThai';

/// The single app theme — modern Material 3 tuned to the web palette so every
/// AppBar, button, field, card and dialog picks it up without per-screen work.
ThemeData buildAppTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: PosColors.navy1,
    primary: PosColors.navy1,
    onPrimary: Colors.white,
    secondary: PosColors.accent,
    onSecondary: Colors.white,
    surface: PosColors.surface,
    onSurface: PosColors.ink,
    error: PosColors.red,
  );

  OutlineInputBorder border(Color c, [double w = 1.5]) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(12),
    borderSide: BorderSide(color: c, width: w),
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: kFontFamily,
    scaffoldBackgroundColor: PosColors.bg,
    splashFactory: InkSparkle.splashFactory,

    appBarTheme: const AppBarTheme(
      backgroundColor: PosColors.navy1,
      foregroundColor: Colors.white,
      elevation: 0,
      scrolledUnderElevation: 2,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontFamily: kFontFamily,
        color: Colors.white,
        fontSize: 18,
        fontWeight: FontWeight.w800,
      ),
    ),

    cardTheme: CardThemeData(
      color: PosColors.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(PosRadii.md),
        side: const BorderSide(color: PosColors.border),
      ),
      clipBehavior: Clip.antiAlias,
    ),

    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: PosColors.navy1,
        foregroundColor: Colors.white,
        minimumSize: const Size(0, 48),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        textStyle: const TextStyle(
          fontFamily: kFontFamily,
          fontSize: 15,
          fontWeight: FontWeight.w700,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
        ),
      ),
    ),

    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: PosColors.navy1,
        foregroundColor: Colors.white,
        elevation: 0,
        minimumSize: const Size(0, 48),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
        ),
      ),
    ),

    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: PosColors.navy1,
        minimumSize: const Size(0, 48),
        side: const BorderSide(color: PosColors.borderStrong),
        textStyle: const TextStyle(
          fontFamily: kFontFamily,
          fontSize: 14,
          fontWeight: FontWeight.w700,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
        ),
      ),
    ),

    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: PosColors.accentDark),
    ),

    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: PosColors.surfaceAlt,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: border(PosColors.borderStrong),
      enabledBorder: border(PosColors.borderStrong),
      focusedBorder: border(PosColors.accent),
      prefixIconColor: PosColors.muted,
      labelStyle: const TextStyle(color: PosColors.inkSoft),
      floatingLabelStyle: const TextStyle(
        color: PosColors.accentDark,
        fontWeight: FontWeight.w700,
      ),
    ),

    chipTheme: ChipThemeData(
      backgroundColor: PosColors.surfaceAlt,
      side: const BorderSide(color: PosColors.border),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      labelStyle: const TextStyle(
        fontFamily: kFontFamily,
        fontWeight: FontWeight.w600,
        fontSize: 12.5,
      ),
    ),

    tabBarTheme: const TabBarThemeData(
      labelColor: Colors.white,
      unselectedLabelColor: Colors.white70,
      indicatorColor: PosColors.gold,
      labelStyle: TextStyle(
        fontFamily: kFontFamily,
        fontWeight: FontWeight.w700,
        fontSize: 12.5,
      ),
    ),

    dialogTheme: DialogThemeData(
      backgroundColor: PosColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(PosRadii.lg),
      ),
      titleTextStyle: const TextStyle(
        fontFamily: kFontFamily,
        color: PosColors.ink,
        fontSize: 18,
        fontWeight: FontWeight.w800,
      ),
    ),

    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: PosColors.ink,
      contentTextStyle: const TextStyle(
        fontFamily: kFontFamily,
        color: Colors.white,
      ),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),

    dividerTheme: const DividerThemeData(
      color: PosColors.border,
      thickness: 1,
      space: 1,
    ),

    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? PosColors.accent : null,
      ),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected)
            ? PosColors.accentSoft
            : null,
      ),
    ),

    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: PosColors.accent,
      foregroundColor: Colors.white,
    ),

    listTileTheme: const ListTileThemeData(iconColor: PosColors.inkSoft),
  );
}
