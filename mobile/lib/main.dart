import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'config.dart';
import 'db/database.dart';
import 'services/auth_service.dart';
import 'services/socket_service.dart';
import 'services/api_service.dart';
import 'services/offline_repository.dart';
import 'services/bluetooth_printer_service.dart';
import 'services/auto_print_service.dart';
import 'screens/kitchen_screen.dart';
import 'screens/staff_screen.dart';
import 'screens/admin_screen.dart';
import 'screens/login_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await AppConfig.bootstrap();
  final auth = AuthService();
  await auth.bootstrap(restoreSession: false);
  final socket = SocketService();
  await socket.bootstrap();
  final db = AppDatabase();
  final api = ApiService(auth);
  final offline = OfflineRepository(api: api, db: db);
  final btPrinter = BluetoothPrinterService();
  await btPrinter.bootstrap();
  final autoPrint = AutoPrintService(
    api: api,
    auth: auth,
    socket: socket,
    printer: btPrinter,
  );
  runApp(
    MyApp(
      auth: auth,
      socket: socket,
      offline: offline,
      btPrinter: btPrinter,
      autoPrint: autoPrint,
    ),
  );
}

class MyApp extends StatelessWidget {
  final AuthService auth;
  final SocketService socket;
  final OfflineRepository offline;
  final BluetoothPrinterService btPrinter;
  final AutoPrintService autoPrint;
  const MyApp({
    super.key,
    required this.auth,
    required this.socket,
    required this.offline,
    required this.btPrinter,
    required this.autoPrint,
  });

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: auth),
        ChangeNotifierProvider.value(value: socket),
        ChangeNotifierProvider.value(value: offline),
        ChangeNotifierProvider.value(value: btPrinter),
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
        return const AdminScreen();
      default:
        return const Scaffold(body: Center(child: Text('Unknown role')));
    }
  }
}
