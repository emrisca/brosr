# Correlation kernel for the Brosr alignment lane.
#
# The wrapper substitutes two envelopes, the last non-negative lag index and
# the bias that turns an index back into a signed lag. The generated file is
# written to a temporary directory, so this template never runs as it stands.
#
# Bend 0.2.38 has u24, i24 and f24, not u32. Envelopes are therefore quantised
# to five bits by the wrapper. A full two hour coarse dot is then at most
# 7200 * 31 * 31, about 6.9 million, which stays inside u24. A byte envelope
# would overflow a u24 dot.
#
# A lag is how much later B's content starts. This file prints one line per
# non-negative index, `index dot`. The wrapper subtracts the bias to recover
# the signed lag and picks the peak. The kernel holds no verdict and no state.
#
# Printing is the only effect. There is no file IO, no indexing and no string
# parsing beyond the decimal formatter, by design: the envelope arrives as a
# literal list, so the whole program is list recursion over cons cells.

def a_data() -> List(u24):
  return [<<A>>]

def b_data() -> List(u24):
  return [<<B>>]

def dot(a: List(u24), b: List(u24)) -> u24:
  match a:
    case List/Cons:
      match b:
        case List/Cons:
          return a.head * b.head + dot(a.tail, b.tail)
        case List/Nil:
          return 0
    case List/Nil:
      return 0

# Drop the first n entries. A lag is expressed by dropping from one head, so
# the two lists meet on the same content without any index arithmetic.
def drop(xs: List(u24), n: u24) -> List(u24):
  if n == 0:
    return xs
  else:
    match xs:
      case List/Cons:
        return drop(xs.tail, n - 1)
      case List/Nil:
        return List/Nil

# A positive signed lag drops B's head, a negative one drops A's. The index is
# shifted by bias so the kernel never needs a signed number.
def at(a: List(u24), b: List(u24), index: u24, bias: u24) -> u24:
  if index > bias:
    return dot(a, drop(b, index - bias))
  else:
    if index < bias:
      return dot(drop(a, bias - index), b)
    else:
      return dot(a, b)

# This Bend version has no String/concat. A String is a list of u24 code
# points, so one recursive helper is enough.
def join(a: String, b: String) -> String:
  match a:
    case String/Cons:
      return String/Cons(a.head, join(a.tail, b))
    case String/Nil:
      return b

def line(index: u24, value: u24) -> String:
  return join(
    u24/to_string(index),
    join(" ", join(u24/to_string(value), "\n"))
  )

def scan(a: List(u24), b: List(u24), index: u24, last: u24, bias: u24) -> IO(u24):
  with IO:
    if index > last:
      return wrap(0)
    else:
      * <- IO/print(line(index, at(a, b, index, bias)))
      return scan(a, b, index + 1, last, bias)

def main() -> IO(u24):
  with IO:
    return scan(a_data(), b_data(), 0, <<LAST_INDEX>>, <<BIAS>>)
