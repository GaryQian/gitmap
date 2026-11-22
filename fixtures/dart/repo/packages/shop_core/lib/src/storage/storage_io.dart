import 'dart:convert';
import 'dart:io';

import '../models/cart.dart';
import 'storage.dart';

class FileCartStorage implements CartStorage {
  FileCartStorage(this._file);

  final File _file;

  @override
  Future<void> save(Cart cart) async {
    await _file.writeAsString(jsonEncode({'totalCents': cart.totalCents}));
  }

  @override
  Future<int> savedTotalCents() async {
    if (!await _file.exists()) return 0;
    final data = jsonDecode(await _file.readAsString()) as Map<String, Object?>;
    return data['totalCents'] as int? ?? 0;
  }
}

CartStorage createStorage() => FileCartStorage(File('cart.json'));
