// The in-memory fallback, used where there is no file system.
// import 'storage_io.dart';
import '../models/cart.dart';
import 'storage.dart';

class MemoryCartStorage implements CartStorage {
  int _totalCents = 0;

  @override
  Future<void> save(Cart cart) async {
    _totalCents = cart.totalCents;
  }

  @override
  Future<int> savedTotalCents() async => _totalCents;
}

CartStorage createStorage() => MemoryCartStorage();
