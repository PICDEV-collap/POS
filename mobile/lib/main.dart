import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'config.dart';
import 'db/database.dart';
import 'services/auth_service.dart';
import 'services/socket_service.dart';
import 'services/api_service.dart';
import 'services/offline_repository.dart';
import 'services/bluetooth_printer_service.dart';
import 'services/pos_printer_service.dart';
import 'services/auto_print_service.dart';
import 'screens/kitchen_screen.dart';
import 'screens/staff_screen.dart';
import 'screens/admin_screen.dart';
import 'screens/login_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  AppConfig.installNetworkOverrides();
  await AppConfig.bootstrap();
  final auth = AuthService();
  await auth.bootstrap(restoreSession: false);
  final socket = SocketService();
  await socket.bootstrap();
  final db = AppDatabase();
  final api = ApiService(auth);
  final offline = OfflineRepository(api: api, db: db);
  final posPrinter = PosPrinterService(bluetooth: BluetoothPrinterService());
  await posPrinter.bootstrap();
  final autoPrint = AutoPrintService(
    api: api,
    auth: auth,
    socket: socket,
    printer: posPrinter,
  );
  runApp(
    MyApp(
      auth: auth,
      socket: socket,
      offline: offline,
      posPrinter: posPrinter,
      autoPrint: autoPrint,
    ),
  );
}

class MyApp extends StatelessWidget {
  final AuthService auth;
  final SocketService socket;
  final OfflineRepository offline;
  final PosPrinterService posPrinter;
  final AutoPrintService autoPrint;
  const MyApp({
    super.key,
    required this.auth,
    required this.socket,
    required this.offline,
    required this.posPrinter,
    required this.autoPrint,
  });

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: auth),
        ChangeNotifierProvider.value(value: socket),
        ChangeNotifierProvider.value(value: offline),
        ChangeNotifierProvider.value(value: posPrinter),
        Provider<AutoPrintService>.value(value: autoPrint),
      ],
      child: MaterialApp(
        title: 'POS V2',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xFF1A1A2E),
            primary: const Color(0xFF1A1A2E),
            secondary: const Color(0xFFFFD166),
          ),
          useMaterial3: true,
        ),
        home: const _RootRouter(),
      ),
    );
  }
}

class _RootRouter extends StatefulWidget {
  const _RootRouter();
  @override
  State<_RootRouter> createState() => _RootRouterState();
}

class _RootRouterState extends State<_RootRouter> with WidgetsBindingObserver {
  bool _autoPrintWired = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final auth = context.read<AuthService>();
    if (!auth.isLoggedIn) return;
    context.read<SocketService>().resume();
    context.read<AutoPrintService>().resume();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    if (!auth.isLoggedIn) return const LoginScreen();
    // Once logged in, attach the auto-print socket listener exactly once
    // for the lifetime of the session. SocketService.connect() is idempotent
    // and called by each role screen; AutoPrintService.start() is too.
    if (!_autoPrintWired) {
      _autoPrintWired = true;
      // Defer to next frame so socket has connected on the originating screen.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        context.read<SocketService>().connect();
        context.read<AutoPrintService>().start();
      });
    }
    switch (auth.user!.role) {
      case 'kitchen':
        return const KitchenScreen();
      case 'staff':
        return const StaffScreen();
      case 'admin':
        if (AppConfig.isPublicRemoteBase &&
            auth.user?.isMobileStoreAdmin != true) {
          return const _RemoteStoreAdminRequiredScreen();
        }
        return const AdminScreen();
      case 'super_admin':
        if (AppConfig.isPublicRemoteBase) {
          return const _RemoteSuperAdminBlockedScreen();
        }
        return const AdminScreen();
      default:
        return const Scaffold(body: Center(child: Text('Unknown role')));
    }
  }
}

class _RemoteStoreAdminRequiredScreen extends StatelessWidget {
  const _RemoteStoreAdminRequiredScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Mobile Admin'),
        backgroundColor: const Color(0xFF1A1A2E),
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            onPressed: () => context.read<AuthService>().logout(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.lock_outline, size: 56),
                const SizedBox(height: 16),
                const Text(
                  'บัญชีนี้ยังไม่ได้เปิดสิทธิ์ mobile store admin',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                Text(
                  'ให้สร้างบัญชี admin ที่ผูกกับร้านและมี permission mobile_admin ก่อนใช้งานนอกวง LAN',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey[700]),
                ),
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: () => context.read<AuthService>().logout(),
                  icon: const Icon(Icons.logout),
                  label: const Text('ออกจากระบบ'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RemoteSuperAdminBlockedScreen extends StatelessWidget {
  const _RemoteSuperAdminBlockedScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Server Admin'),
        backgroundColor: const Color(0xFF1A1A2E),
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            onPressed: () => context.read<AuthService>().logout(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.admin_panel_settings,
                  size: 56,
                  color: Color(0xFF1A1A2E),
                ),
                const SizedBox(height: 16),
                const Text(
                  'บัญชี server admin ใช้ได้เฉพาะในวง LAN ของเครื่อง server',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 8),
                Text(
                  'ถ้าต้องจัดการร้านจากมือถือผ่าน public URL ให้ใช้บัญชี store admin ที่ผูกกับร้านนั้น',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.grey[700]),
                ),
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: () => context.read<AuthService>().logout(),
                  icon: const Icon(Icons.logout),
                  label: const Text('ออกจากระบบ'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
