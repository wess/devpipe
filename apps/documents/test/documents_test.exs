defmodule DocumentsTest do
  use ExUnit.Case
  doctest Documents

  test "greets the world" do
    assert Documents.hello() == :world
  end
end
