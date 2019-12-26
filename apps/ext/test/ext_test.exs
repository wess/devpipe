defmodule ExtTest do
  use ExUnit.Case
  doctest Ext

  test "greets the world" do
    assert Ext.hello() == :world
  end
end
