#include <string>

#include "billing/invoice_items.pb.h"
#include "inventory/v1/stock.grpc.pb.h"

std::string Describe(const billing::InvoiceItems &items) {
  return items.DebugString();
}
