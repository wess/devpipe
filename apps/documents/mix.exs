#
#  mix.exs
#  documents
# 
#  Created by Wess Cope (me@wess.io) on 12/12/19
#  Copyright 2019 Wess Cope
#

defmodule Documents.MixProject do
  use Mix.Project

  def project do
    [
      app:              :documents,
      version:          "0.0.1",
      build_path:       "../../_build",
      config_path:      "../../config/config.exs",
      deps_path:        "../../deps",
      lockfile:         "../../mix.lock",
      elixir:           "~> 1.9",
      start_permanent:  Mix.env() == :prod,
      deps:             deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:data, in_umbrella: true},
      {:ext,  in_umbrella: true}
    ]
  end
end
