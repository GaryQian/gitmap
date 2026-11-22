import '../models/cart.dart';
import 'storage_stub.dart'
    if (dart.library.io) 'storage_io.dart';

/// Keeps a cart between sessions.
abstract interface class CartStorage {
  Future<void> save(Cart cart);

  Future<int> savedTotalCents();
}

/// The storage for the platform the app was compiled for.
CartStorage openStorage() => createStorage();
